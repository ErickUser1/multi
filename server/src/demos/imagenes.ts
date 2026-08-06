import { createServer } from "node:http";
import { AnthropicProvider } from "../agent/providers/anthropic.js";
import { OpenAICompatProvider } from "../agent/providers/openai-compat.js";
import { proveedorVe } from "../agent/providers/profiles.js";
import type { Message } from "../agent/providers/types.js";

/**
 * Demo: una imagen del chat llega al modelo en el formato que cada API espera.
 * Uso: npm run demo:imagenes
 *
 * Lo que cubre: los dos proveedores hablan formatos distintos para lo mismo.
 * Anthropic quiere `source: { type: "base64", media_type, data }`; los de
 * formato OpenAI quieren un data URI dentro de `image_url`. Escribir uno de los
 * dos mal no rompe la compilación: rompe en producción con un 400 que no dice
 * gran cosa.
 *
 * Los dos formatos están verificados contra la documentación oficial de cada uno
 * (agosto de 2026), incluido el orden: la imagen va ANTES del texto porque los
 * modelos responden mejor viendo primero y leyendo después.
 *
 * No usa red ni API key: los servidores falsos responden como los reales y
 * guardan el cuerpo que recibieron para poder revisarlo.
 */

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  [ok] ${name}`);
  } else {
    fail++;
    console.log(`  [X]  ${name} ${detail}`);
  }
}

/** Un PNG de 1x1 pixel. Lo mínimo que sigue siendo una imagen de verdad. */
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

/**
 * Servidor que acepta cualquier cosa y guarda el cuerpo que le mandaron.
 * Responde el SSE mínimo de cada formato para que el proveedor no truene.
 */
function servidorEspia(formato: "anthropic" | "openai"): Promise<{
  url: string;
  ultimoCuerpo: () => any;
  cerrar: () => void;
}> {
  let cuerpo: any = null;
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        cuerpo = JSON.parse(raw);
        res.writeHead(200, { "content-type": "text/event-stream" });

        if (formato === "anthropic") {
          const ev = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
          ev({ type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 1 } } });
          ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
          ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "listo" } });
          ev({ type: "content_block_stop", index: 0 });
          ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
          ev({ type: "message_stop" });
        } else {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "listo" } }] })}\n\n`);
          res.write(
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
          );
          res.write("data: [DONE]\n\n");
        }
        res.end();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${port}`,
        ultimoCuerpo: () => cuerpo,
        cerrar: () => server.close(),
      });
    });
  });
}

/** El mensaje tal como lo arma la sala: la imagen primero, la pregunta después. */
function mensajeConImagen(): Message[] {
  return [
    {
      role: "user",
      content: [
        { type: "image", mediaType: "image/png", data: PNG_1X1 },
        { type: "text", text: "adjuntó logo.png. ponlo en el header" },
      ],
    },
  ];
}

async function main(): Promise<void> {
  console.log("\nDemo: las imágenes del chat llegan al modelo\n");

  // ── 1. Anthropic ──────────────────────────────────────────────────────────
  console.log("Anthropic (source.base64):");
  {
    const espia = await servidorEspia("anthropic");
    // El proveedor apunta a su URL fija, así que se le cambia por la del espía.
    const provider = new AnthropicProvider("sk-ant-falsa");
    const original = globalThis.fetch;
    globalThis.fetch = ((url: any, init: any) =>
      original(espia.url, init)) as typeof fetch;

    await provider.stream({ messages: mensajeConImagen(), maxTokens: 64 });
    globalThis.fetch = original;

    const bloques = espia.ultimoCuerpo()?.messages?.[0]?.content ?? [];
    const img = bloques.find((b: any) => b.type === "image");

    check("manda un bloque type:image", !!img);
    check(
      "lo envuelve en source.type = base64",
      img?.source?.type === "base64",
      `→ ${JSON.stringify(img?.source?.type)}`,
    );
    check(
      "usa media_type (con guion bajo, como pide su API)",
      img?.source?.media_type === "image/png",
      `→ ${JSON.stringify(img?.source?.media_type)}`,
    );
    check("manda el base64 pelón, sin prefijo data:", img?.source?.data === PNG_1X1);
    check(
      "la imagen va ANTES del texto",
      bloques[0]?.type === "image" && bloques[1]?.type === "text",
      `→ ${bloques.map((b: any) => b.type).join(", ")}`,
    );

    espia.cerrar();
  }

  // ── 2. Formato OpenAI ─────────────────────────────────────────────────────
  console.log("\nFormato OpenAI (image_url con data URI):");
  {
    const espia = await servidorEspia("openai");
    const provider = new OpenAICompatProvider({
      apiKey: "sk-falsa",
      baseUrl: espia.url,
      defaultModel: "gpt-5.6-terra",
      name: "OpenAI",
    });

    await provider.stream({ messages: mensajeConImagen(), maxTokens: 64 });

    const partes = espia.ultimoCuerpo()?.messages?.[0]?.content ?? [];
    const img = Array.isArray(partes) ? partes.find((p: any) => p.type === "image_url") : null;

    check("el contenido pasa a ser una lista de partes", Array.isArray(partes));
    check("manda una parte type:image_url", !!img);
    check(
      "image_url es un objeto con url adentro, no un string",
      typeof img?.image_url === "object" && typeof img?.image_url?.url === "string",
      `→ ${typeof img?.image_url}`,
    );
    check(
      "la url es un data URI completo",
      img?.image_url?.url === `data:image/png;base64,${PNG_1X1}`,
    );
    check(
      "la imagen va ANTES del texto",
      partes[0]?.type === "image_url" && partes[1]?.type === "text",
      `→ ${(partes as any[]).map((p) => p.type).join(", ")}`,
    );

    espia.cerrar();
  }

  // ── 3. Un mensaje sin imágenes no cambia ──────────────────────────────────
  console.log("\nSin imágenes, nada cambia:");
  {
    const espia = await servidorEspia("openai");
    const provider = new OpenAICompatProvider({
      apiKey: "sk-falsa",
      baseUrl: espia.url,
      defaultModel: "gpt-5.6-terra",
      name: "OpenAI",
    });

    await provider.stream({
      messages: [{ role: "user", content: [{ type: "text", text: "hola" }] }],
      maxTokens: 64,
    });

    const contenido = espia.ultimoCuerpo()?.messages?.[0]?.content;
    check(
      "el contenido sigue siendo un string plano",
      contenido === "hola",
      `→ ${JSON.stringify(contenido)}`,
    );

    espia.cerrar();
  }

  // ── 4. Quién ve y quién no ────────────────────────────────────────────────
  console.log("\nQuién puede recibir la imagen:");
  check("anthropic ve", proveedorVe("anthropic") === true);
  check("openai ve", proveedorVe("openai") === true);
  check("groq no ve", proveedorVe("groq") === false);
  check("deepseek no ve", proveedorVe("deepseek") === false);
  check("ollama no ve", proveedorVe("ollama") === false);
  check(
    "openrouter no ve (mezcla modelos que ven y que no)",
    proveedorVe("openrouter") === false,
  );

  console.log(`\n${pass} bien, ${fail} mal\n`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
