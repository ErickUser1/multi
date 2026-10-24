// Mide cuánto tarda en llegar el input de una tool grande, sin y con eager_input_streaming.
// Uso (desde server/, para leer su .env): node ../scripts/medir-stream.mjs [modelo]
import { readFileSync } from "node:fs";

const env = readFileSync(".env", "utf8");
const KEY = env.match(/^(?:MULTI_API_KEY|ANTHROPIC_API_KEY)=(.*)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "");
if (!KEY) throw new Error("no encontré MULTI_API_KEY ni ANTHROPIC_API_KEY en .env");
const MODELO = process.argv[2] ?? "claude-sonnet-5-5";

const PEDIDO =
  "Escribe con write_file el archivo src/juego.js: un juego de carreras completo en canvas, " +
  "de unas 900 líneas, con pista, kart, 3 rivales con IA, física simple, HUD y menú. " +
  "Todo en ese único archivo, de un jalón. No expliques nada, solo llama write_file.";

async function medir(eager) {
  const tool = {
    name: "write_file",
    description: "Escribe un archivo completo.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
    ...(eager ? { eager_input_streaming: true } : {}),
  };
  const t0 = Date.now();
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: MODELO,
      max_tokens: 32000,
      stream: true,
      tools: [tool],
      messages: [{ role: "user", content: PEDIDO }],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

  const seg = () => ((Date.now() - t0) / 1000).toFixed(1);
  let buffer = "";
  let ultimoReal = Date.now(); // último evento que no fue ping
  let huecoMax = 0;
  let primerInput = null;
  let pedazos = 0;
  let pings = 0;
  let salida = 0;
  let textoYPensar = 0;
  let bytesInput = 0;
  let ultimoPing = null;
  // Cada 10 s una línea, para ver en vivo si llega algo o si la conexión está muda.
  const latido = setInterval(() => {
    const desdeAlgo = ((Date.now() - ultimoReal) / 1000).toFixed(0);
    const desdePing = ultimoPing ? ((Date.now() - ultimoPing) / 1000).toFixed(0) + "s" : "nunca";
    console.log(`  ${seg()}s  pedazos ${pedazos} (${bytesInput} chars)  texto/pensar ${textoYPensar}  pings ${pings}  sin datos hace ${desdeAlgo}s  último ping hace ${desdePing}`);
  }, 10_000);
  const tope = setTimeout(() => {
    console.log(`  ${seg()}s  15 min sin terminar: corto`);
    reader.cancel().catch(() => {});
  }, 15 * 60_000);
  console.log(`\n${eager ? "CON" : "SIN"} eager_input_streaming (respuesta HTTP a los ${seg()}s)`);
  const dec = new TextDecoder();
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read().catch((e) => {
      console.log(`  ${seg()}s  la lectura falló: ${e}`);
      return { done: true };
    });
    if (done) break;
    buffer += dec.decode(value, { stream: true });
    let i;
    while ((i = buffer.indexOf("\n\n")) !== -1) {
      const bloque = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      const data = bloque.split("\n").find((l) => l.startsWith("data: "));
      if (!data) continue;
      const ev = JSON.parse(data.slice(6));
      if (ev.type === "ping") {
        pings++;
        ultimoPing = Date.now();
        continue;
      }
      const ahora = Date.now();
      huecoMax = Math.max(huecoMax, ahora - ultimoReal);
      ultimoReal = ahora;
      if (ev.type === "content_block_delta" && ev.delta?.type === "input_json_delta") {
        pedazos++;
        bytesInput += ev.delta.partial_json.length;
        if (primerInput === null) primerInput = seg();
      }
      if (ev.type === "content_block_delta" && ev.delta?.type !== "input_json_delta") textoYPensar++;
      if (ev.type === "content_block_start") console.log(`  ${seg()}s  empieza bloque ${ev.content_block.type}${ev.content_block.name ? " " + ev.content_block.name : ""}`);
      if (ev.type === "message_delta") salida = ev.usage?.output_tokens ?? salida;
      if (ev.type === "error") console.log("  error del stream:", JSON.stringify(ev.error));
    }
  }
  clearInterval(latido);
  clearTimeout(tope);
  console.log(`  resultado ${eager ? "CON" : "SIN"} eager:`);
  console.log(`  primer pedazo del archivo: a los ${primerInput}s`);
  console.log(`  pedazos del archivo:       ${pedazos}`);
  console.log(`  silencio más largo:        ${(huecoMax / 1000).toFixed(1)}s (solo pings: ${pings})`);
  console.log(`  total:                     ${seg()}s, ${salida} tokens de salida`);
}

console.log(`Modelo: ${MODELO}`);
await medir(false);
await medir(true);
