import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent, TOOL_INTERRUMPIDA } from "../agent/loop.js";
import { localRunner, type Runner } from "../engine/runner.js";
import { AnthropicProvider } from "../agent/providers/anthropic.js";
import { bashTool } from "../agent/tools/bash.js";
import type { ContentBlock, Message, ModelProvider, StreamEvent, StopReason } from "../agent/providers/types.js";
import type { ToolContext } from "../agent/tools/base.js";

/**
 * Demo: el agente no se queda mudo ni colgado.
 * Uso: npm run demo:stream-vivo
 *
 * Lo que la motivó, en una sala real: al pedir "rehazlo en 3D" el agente quiso
 * escribir todo el juego en un archivo. Sin `eager_input_streaming` Anthropic
 * junta el input completo antes de mandarlo, así que fueron minutos sin un solo
 * byte: la sala en "trabajando" sin enseñar nada, y un "@agente" que no lo
 * soltaba. Se terminó reiniciando el server.
 *
 * Lo que se revisa:
 *   1. Las tools van con `eager_input_streaming` (las de web no).
 *   2. La sala sabe qué archivo se está escribiendo antes de que termine.
 *   3. Un stream que se queda callado se corta y se reintenta solo.
 *   4. Interrumpir corta al instante, sin reintentos.
 *   5. Interrumpir no espera a una tool lenta, y el historial queda válido.
 *   6. Un input que no parsea se contesta con error, sin tumbar el turno.
 *   7. bash no acepta un timeout de horas.
 *
 * Sin red ni API key: `fetch` falso que manda el SSE a mano, a su ritmo.
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

const enc = new TextEncoder();
const sse = (eventos: object[]) => eventos.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join("");
const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

const INICIO = { type: "message_start", message: { usage: { input_tokens: 4, output_tokens: 0 } } };
const FIN = (stop: StopReason) => [
  { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 10 } },
  { type: "message_stop" },
];
const RESPUESTA_CORTA = [
  INICIO,
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hola" } },
  { type: "content_block_stop", index: 0 },
  ...FIN("end_turn"),
];

type Pedazo = { despuesDe: number; texto: string };

/**
 * Un `fetch` falso que manda los pedazos con pausas, y con `callarse` deja la
 * conexión abierta sin mandar nada más. Respeta el abort como el de verdad.
 */
function fetchFalso(guiones: { pedazos: Pedazo[]; callarse?: boolean }[], registro: { bodies: any[] }): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const signal = init?.signal ?? undefined;
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    registro.bodies.push(JSON.parse(String(init?.body)));
    const guion = guiones[Math.min(registro.bodies.length - 1, guiones.length - 1)];
    const body = new ReadableStream<Uint8Array>({
      async start(c) {
        let cortado = false;
        signal?.addEventListener("abort", () => {
          cortado = true;
          try {
            c.error(new DOMException("aborted", "AbortError"));
          } catch {
            // Ya estaba cerrado.
          }
        });
        for (const p of guion.pedazos) {
          await espera(p.despuesDe);
          if (cortado) return;
          c.enqueue(enc.encode(p.texto));
        }
        if (!guion.callarse && !cortado) c.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
}

/** Proveedor falso con guion, para las pruebas del loop. */
function proveedor(
  vueltas: { stop: StopReason; content: ContentBlock[]; inputsInvalidos?: string[] }[],
): { provider: ModelProvider; llamadas: Message[][] } {
  const llamadas: Message[][] = [];
  const provider: ModelProvider = {
    name: "falso",
    defaultModel: "falso/modelo",
    async stream(params): Promise<Extract<StreamEvent, { type: "end" }>> {
      llamadas.push(JSON.parse(JSON.stringify(params.messages)));
      const v = vueltas[llamadas.length - 1];
      if (!v) throw new Error(`el guion no tiene vuelta ${llamadas.length - 1}`);
      return {
        type: "end",
        stopReason: v.stop,
        message: { role: "assistant", content: v.content },
        usage: { inputTokens: 0, outputTokens: 10 },
        inputsInvalidos: v.inputsInvalidos,
      };
    },
  };
  return { provider, llamadas };
}

function toolsEmparejadas(messages: Message[]): boolean {
  const usados = new Set<string>();
  const resueltos = new Set<string>();
  for (const m of messages) {
    for (const c of m.content) {
      if (c.type === "tool_use") usados.add(c.id);
      if (c.type === "tool_result") resueltos.add(c.tool_use_id);
    }
  }
  for (const id of usados) if (!resueltos.has(id)) return false;
  return true;
}

function resultadoDe(messages: Message[], id: string): string | undefined {
  for (const m of messages) {
    for (const c of m.content) {
      if (c.type === "tool_result" && c.tool_use_id === id) return typeof c.content === "string" ? c.content : JSON.stringify(c.content);
    }
  }
  return undefined;
}

const TOOL_WRITE = {
  name: "write_file",
  description: "escribe",
  input_schema: { type: "object" as const, properties: { path: { type: "string" }, content: { type: "string" } } },
};

async function main() {
  console.log("=== El agente no se queda mudo ni colgado ===\n");
  const original = globalThis.fetch;
  const dir = await mkdtemp(join(tmpdir(), "multi-stream-vivo-"));

  try {
    console.log("1. Las tools van con eager_input_streaming");
    {
      const registro = { bodies: [] as any[] };
      globalThis.fetch = fetchFalso([{ pedazos: [{ despuesDe: 0, texto: sse(RESPUESTA_CORTA) }] }], registro);
      await new AnthropicProvider("sk-falsa").stream({ messages: [], tools: [TOOL_WRITE], model: "claude-sonnet-5-5" });
      const tools = registro.bodies[0]?.tools ?? [];
      const nuestra = tools.find((t: any) => t.name === "write_file");
      const web = tools.filter((t: any) => t.name !== "write_file");
      check("write_file lleva eager_input_streaming", nuestra?.eager_input_streaming === true, JSON.stringify(nuestra));
      check("las de internet no (no son nuestras)", web.length > 0 && web.every((t: any) => t.eager_input_streaming === undefined));
    }

    console.log("\n2. La sala sabe qué archivo se escribe antes de que termine");
    {
      const registro = { bodies: [] as any[] };
      const t0 = Date.now();
      globalThis.fetch = fetchFalso(
        [
          {
            pedazos: [
              {
                despuesDe: 0,
                texto: sse([
                  INICIO,
                  { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "write_file" } },
                  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path": "src/jue' } },
                  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'go.js", "content": "// mucho código' } },
                ]),
              },
              {
                despuesDe: 400,
                texto: sse([
                  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: ' más"}' } },
                  { type: "content_block_stop", index: 0 },
                  ...FIN("tool_use"),
                ]),
              },
            ],
          },
        ],
        registro,
      );
      const anuncios: { path: unknown; ms: number }[] = [];
      const fin = await new AnthropicProvider("sk-falsa").stream(
        { messages: [], tools: [TOOL_WRITE] },
        { onToolPreparing: ({ input }) => anuncios.push({ path: input.path, ms: Date.now() - t0 }) },
      );
      const total = Date.now() - t0;
      check("se anuncia una sola vez", anuncios.length === 1, JSON.stringify(anuncios));
      check("con la ruta completa", anuncios[0]?.path === "src/juego.js", String(anuncios[0]?.path));
      check("mucho antes de que termine el archivo", (anuncios[0]?.ms ?? total) < 200 && total >= 400, `${anuncios[0]?.ms}ms de ${total}ms`);
      const tu = fin.message.content.find((c) => c.type === "tool_use");
      check("y el input completo llega igual", tu?.type === "tool_use" && tu.input.content === "// mucho código más");
    }

    console.log("\n3. Un stream que se queda callado se corta y se reintenta solo");
    {
      process.env.MULTI_STREAM_SILENCIO_MS = "300";
      const registro = { bodies: [] as any[] };
      globalThis.fetch = fetchFalso(
        [
          { pedazos: [{ despuesDe: 0, texto: sse([INICIO]) }], callarse: true },
          { pedazos: [{ despuesDe: 0, texto: sse(RESPUESTA_CORTA) }] },
        ],
        registro,
      );
      const reintentos: string[] = [];
      const t0 = Date.now();
      const fin = await new AnthropicProvider("sk-falsa").stream(
        { messages: [] },
        { onRetry: ({ reason }) => reintentos.push(reason) },
      );
      check("se reintentó una vez", registro.bodies.length === 2 && reintentos.length === 1, `${registro.bodies.length} requests`);
      check("como falla de red", reintentos[0] === "network", reintentos[0]);
      check("y el segundo sí contestó", fin.stopReason === "end_turn");
      check("sin quedarse esperando para siempre", Date.now() - t0 < 5_000, `${Date.now() - t0}ms`);
      delete process.env.MULTI_STREAM_SILENCIO_MS;
    }

    console.log("\n4. Interrumpir corta al instante, sin reintentos");
    {
      const registro = { bodies: [] as any[] };
      globalThis.fetch = fetchFalso([{ pedazos: [{ despuesDe: 0, texto: sse([INICIO]) }], callarse: true }], registro);
      const corte = new AbortController();
      setTimeout(() => corte.abort(), 100);
      const t0 = Date.now();
      let error = "";
      try {
        await new AnthropicProvider("sk-falsa").stream({ messages: [], signal: corte.signal });
      } catch (err) {
        error = String(err);
      }
      const tardo = Date.now() - t0;
      check("lanza", error.length > 0);
      check("en menos de un segundo", tardo < 1_000, `${tardo}ms`);
      check("sin volver a llamar a la API", registro.bodies.length === 1, `${registro.bodies.length} requests`);
    }

    console.log("\n5. Interrumpir no espera a una tool lenta");
    {
      const { provider } = proveedor([
        {
          stop: "tool_use",
          content: [
            { type: "tool_use", id: "tu_lenta", name: "bash", input: { command: "sleep 5" } },
            { type: "tool_use", id: "tu_rapida", name: "bash", input: { command: "echo listo" } },
          ],
        },
      ]);
      const corte = new AbortController();
      setTimeout(() => corte.abort(), 500);
      const t0 = Date.now();
      const r = await runAgent({
        provider,
        workspaceDir: dir,
        runner: localRunner(dir),
        messages: [],
        userMessage: "corre esto",
        signal: corte.signal,
      });
      const tardo = Date.now() - t0;
      check("el turno se suelta casi al instante", tardo < 2_000, `${tardo}ms`);
      check("sale marcado como interrumpido", r.interrumpido === true);
      check("cada tool_use tiene su tool_result", toolsEmparejadas(r.messages));
      check("la lenta dice que la interrumpieron", resultadoDe(r.messages, "tu_lenta") === TOOL_INTERRUMPIDA, resultadoDe(r.messages, "tu_lenta"));
      check("la rápida conserva su resultado", resultadoDe(r.messages, "tu_rapida")?.includes("listo") === true, resultadoDe(r.messages, "tu_rapida"));
    }

    console.log("\n6. Un input que no parsea se contesta con error y el turno sigue");
    {
      const { provider, llamadas } = proveedor([
        {
          stop: "tool_use",
          content: [{ type: "tool_use", id: "tu_rota", name: "write_file", input: {} }],
          inputsInvalidos: ["tu_rota"],
        },
        { stop: "end_turn", content: [{ type: "text", text: "ya lo repetí" }] },
      ]);
      const r = await runAgent({ provider, workspaceDir: dir, runner: localRunner(dir), messages: [], userMessage: "escribe" });
      const resultado = resultadoDe(r.messages, "tu_rota") ?? "";
      check("no se ejecutó con el input vacío", resultado.includes("no llegaron como JSON válido"), resultado);
      check("el modelo recibió el error y siguió", llamadas.length === 2 && r.finalText === "ya lo repetí", r.finalText);
      check("historial válido", toolsEmparejadas(r.messages));
    }

    console.log("\n7. bash no acepta un timeout de horas");
    {
      let pedido = 0;
      const runner: Runner = {
        isolated: false,
        async exec(_cmd, opts) {
          pedido = opts.timeoutMs;
          return { stdout: "", stderr: "", code: 0, timedOut: false };
        },
      } as Runner;
      const ctx = { workspaceDir: dir, runner } as ToolContext;
      await bashTool.run({ command: "npm run dev", timeout_ms: 10 * 60 * 60_000 }, ctx);
      check("se topa en 10 minutos", pedido === 600_000, String(pedido));
      await bashTool.run({ command: "ls" }, ctx);
      check("sin pedir nada, el default de siempre", pedido === 120_000, String(pedido));
    }
  } finally {
    globalThis.fetch = original;
    await rm(dir, { recursive: true, force: true });
  }

  console.log(`\n${pass} pasaron, ${fail} fallaron`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
