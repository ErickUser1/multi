import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent, AVISO_SIN_ESPACIO, TOPE_REINTENTO } from "../agent/loop.js";
import { localRunner } from "../engine/runner.js";
import { AnthropicProvider } from "../agent/providers/anthropic.js";
import type { ContentBlock, Message, ModelProvider, StopReason, StreamEvent } from "../agent/providers/types.js";

/**
 * Demo: el agente no se queda callado cuando se acaba su tope de salida.
 * Uso: npm run demo:sin-espacio
 *
 * El bug que cubre, visto en una sala real: pidieron una página de outfits "con
 * mucha variedad" y el modelo se gastó los 32k de salida pensando, sin escribir
 * nada. El turno terminó con un mensaje EN BLANCO del agente, el historial quedó
 * con un `assistant []`, y el preview con el error de un `main.tsx` que
 * importaba un `App.tsx` que nunca llegó. Volvió a pasar con el siguiente pedido.
 *
 * No necesita red ni API key: un proveedor falso con guion, y para Anthropic un
 * `fetch` falso que devuelve el SSE a mano.
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

type Vuelta = { stop: StopReason; content: ContentBlock[]; herramientaCortada?: boolean };

/** Proveedor falso: una respuesta por vuelta, en orden. Guarda lo que se le mandó. */
function proveedor(
  vueltas: Vuelta[],
  name = "falso",
): { provider: ModelProvider; llamadas: Message[][]; topes: (number | undefined)[] } {
  const llamadas: Message[][] = [];
  const topes: (number | undefined)[] = [];
  const provider: ModelProvider = {
    name,
    defaultModel: "falso/modelo",
    async stream(params): Promise<Extract<StreamEvent, { type: "end" }>> {
      // Copia profunda: el loop sigue mutando el array después.
      llamadas.push(JSON.parse(JSON.stringify(params.messages)));
      topes.push(params.maxTokens);
      const v = vueltas[llamadas.length - 1];
      if (!v) throw new Error(`el guion no tiene vuelta ${llamadas.length - 1}`);
      return {
        type: "end",
        stopReason: v.stop,
        message: { role: "assistant", content: v.content },
        usage: { inputTokens: 0, outputTokens: v.stop === "max_tokens" ? 32000 : 10 },
        herramientaCortada: v.herramientaCortada,
      };
    },
  };
  return { provider, llamadas, topes };
}

const VACIO: Vuelta = { stop: "max_tokens", content: [] };
const listo = (texto: string): Vuelta => ({ stop: "end_turn", content: [{ type: "text", text: texto }] });

function hayAssistantVacio(msgs: Message[]): boolean {
  return msgs.some((m) => m.role === "assistant" && m.content.length === 0);
}

function llevaElAviso(msgs: Message[]): boolean {
  const ultimo = msgs[msgs.length - 1];
  return ultimo?.role === "user" && ultimo.content.some((c) => c.type === "text" && c.text === AVISO_SIN_ESPACIO);
}

/** Cada tool_use del historial tiene su tool_result. Es lo que la API exige. */
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

/** Un `fetch` falso que contesta con estos eventos SSE. */
function fetchConSse(eventos: object[]): typeof fetch {
  const cuerpo = eventos.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return (async () =>
    new Response(new TextEncoder().encode(cuerpo), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as typeof fetch;
}

/** Un tool_use de write_file cuyo JSON se corta a la mitad, con esta stop_reason. */
function sseConToolTruncado(stop: StopReason): object[] {
  return [
    { type: "message_start", message: { usage: { input_tokens: 4, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Va el archivo." } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_1", name: "write_file" } },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"path":"src/App.tsx","content":"export function App() { return <main>' },
    },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 32000 } },
    { type: "message_stop" },
  ];
}

async function main() {
  console.log("=== El agente no se queda callado sin espacio ===\n");
  const dir = await mkdtemp(join(tmpdir(), "multi-sin-espacio-"));
  const base = { workspaceDir: dir, runner: localRunner(dir), messages: [] as Message[], userMessage: "haz la página de outfits" };

  try {
    console.log("1. Se gasta el tope pensando, y al segundo intento sí escribe");
    {
      const { provider, llamadas } = proveedor([VACIO, listo("Ya está la página de outfits.")]);
      const r = await runAgent({ ...base, provider });
      check("se reintentó una vez", llamadas.length === 2, `${llamadas.length} llamadas`);
      check("el reintento lleva el aviso de escribir por partes", llevaElAviso(llamadas[1] ?? []));
      check("termina con la respuesta del segundo intento", r.finalText === "Ya está la página de outfits.", r.finalText);
      check("no queda marcado como sin espacio", !r.sinEspacio);
      check("el historial no tiene ningún assistant vacío", !hayAssistantVacio(r.messages));
      check("ni en lo que se le mandó al modelo", !llamadas.some(hayAssistantVacio));
    }

    console.log("\n2. Se lo gasta dos veces: se rinde y lo dice, sin un tercer intento");
    {
      const { provider, llamadas } = proveedor([VACIO, VACIO, listo("no debería llegar aquí")]);
      const r = await runAgent({ ...base, provider });
      check("solo dos llamadas (no se queman otros 32k)", llamadas.length === 2, `${llamadas.length} llamadas`);
      check("sale marcado como sin espacio", r.sinEspacio === true);
      check("el texto viene vacío (lo pone index.ts)", r.finalText === "", r.finalText);
      check("el historial no tiene ningún assistant vacío", !hayAssistantVacio(r.messages));
    }

    console.log("\n3. Se corta después de una tool completa: la tool corre y nada queda suelto");
    {
      const { provider, llamadas } = proveedor([
        {
          stop: "max_tokens",
          content: [
            { type: "tool_use", id: "tu_a", name: "write_file", input: { path: "src/App.tsx", content: "export const App = () => null;\n" } },
          ],
        },
        listo("Listo, ya hay App.tsx."),
      ]);
      const r = await runAgent({ ...base, provider });
      const escrito = await readFile(join(dir, "src/App.tsx"), "utf8").catch(() => "");
      check("la tool se ejecutó (el archivo existe)", escrito.includes("export const App"));
      check("cada tool_use tiene su tool_result", toolsEmparejadas(r.messages));
      check("el reintento lleva el aviso junto a los resultados", llevaElAviso(llamadas[1] ?? []));
      check("termina normal", r.finalText === "Listo, ya hay App.tsx." && !r.sinEspacio, r.finalText);
    }

    console.log("\n4. Si lo que se cortó fue una herramienta, el reintento lleva más espacio");
    {
      const cortada: Vuelta = { stop: "max_tokens", content: [], herramientaCortada: true };
      const a = proveedor([cortada, listo("ya")], "anthropic");
      await runAgent({ ...base, provider: a.provider });
      check(`con Anthropic el reintento pide ${TOPE_REINTENTO}`, a.topes[1] === TOPE_REINTENTO, String(a.topes[1]));
      check("y el primer intento no", a.topes[0] === undefined, String(a.topes[0]));

      const pensando = proveedor([VACIO, listo("ya")], "anthropic");
      await runAgent({ ...base, provider: pensando.provider });
      check("si se lo gastó pensando, el tope no sube", pensando.topes[1] === undefined, String(pensando.topes[1]));

      const otro = proveedor([cortada, listo("ya")], "openrouter");
      await runAgent({ ...base, provider: otro.provider });
      check("con otro proveedor no se sube (su techo varía por modelo)", otro.topes[1] === undefined, String(otro.topes[1]));
    }

    console.log("\n5. Anthropic: un tool_use truncado por el tope no es un error");
    {
      const original = globalThis.fetch;
      try {
        globalThis.fetch = fetchConSse(sseConToolTruncado("max_tokens"));
        const fin = await new AnthropicProvider("sk-falsa").stream({ messages: [] });
        check("no lanza", true);
        check("stop_reason max_tokens", fin.stopReason === "max_tokens", fin.stopReason);
        check("el bloque truncado se descarta", !fin.message.content.some((c) => c.type === "tool_use"));
        check("y avisa que fue una herramienta", fin.herramientaCortada === true);
        check("el texto de antes se queda", fin.message.content.some((c) => c.type === "text" && c.text === "Va el archivo."));

        globalThis.fetch = fetchConSse(sseConToolTruncado("tool_use"));
        let lanzo = "";
        try {
          await new AnthropicProvider("sk-falsa").stream({ messages: [] });
        } catch (err) {
          lanzo = String(err);
        }
        check("con otra stop_reason sigue siendo un error", lanzo.includes("se cortó a media escritura"), lanzo.slice(0, 80));
      } finally {
        globalThis.fetch = original;
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  console.log(`\n${pass} pasaron, ${fail} fallaron`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
