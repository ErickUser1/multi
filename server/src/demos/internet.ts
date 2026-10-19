import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent, sinBusquedasColgadas, servidorPendiente } from "../agent/loop.js";
import { localRunner } from "../engine/runner.js";
import { accionDeTool } from "../engine/actividad.js";
import { AnthropicProvider, herramientasWeb, busquedasEn } from "../agent/providers/anthropic.js";
import type { ContentBlock, Message, ModelProvider, StopReason, StreamEvent } from "../agent/providers/types.js";

/**
 * Demo: el agente busca en internet con las herramientas de Anthropic.
 * Uso: npm run demo:internet
 *
 * Buscar y leer páginas corren del lado de Anthropic, y lo que regresan trae
 * `encrypted_content` que la API valida byte por byte: si el historial lo
 * cambia, el turno siguiente es un 400. Aquí se revisa que esos bloques se
 * regresen idénticos, que una pausa se retome sin mensaje nuevo, que una
 * búsqueda que espera a una tool nuestra no reciba nada más que tool_result, y
 * que lo guardado no deje ninguna colgada.
 *
 * Sin red ni API key: un `fetch` falso con el SSE a mano y un proveedor con guion.
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

const USO: Record<string, unknown> = {
  type: "server_tool_use",
  id: "srvtoolu_1",
  name: "web_search",
  input: { query: "ciclo del agua wikimedia" },
};
const RESULTADO: Record<string, unknown> = {
  type: "web_search_tool_result",
  tool_use_id: "srvtoolu_1",
  content: [
    {
      type: "web_search_result",
      url: "https://commons.wikimedia.org/wiki/File:Water_cycle.png",
      title: "Water cycle",
      encrypted_content: "EqgfCioIARgBIiQ3YTAwMjY1Mi1mZjM5LTQ1NGUtODgxNC1kNjNjNTk1ZWI3Y",
      page_age: "April 30, 2025",
    },
  ],
};

/** El SSE de una búsqueda: texto, la llamada en deltas, el resultado entero, y la respuesta. */
function sseDeBusqueda(): object[] {
  const { input: _input, ...inicio } = USO;
  return [
    { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Busco una foto." } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { ...inicio, input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"query":"ciclo del' } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: ' agua wikimedia"}' } },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: RESULTADO },
    { type: "content_block_stop", index: 2 },
    { type: "content_block_start", index: 3, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 3, delta: { type: "text_delta", text: "Encontré una en Wikimedia." } },
    { type: "content_block_stop", index: 3 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 50, server_tool_use: { web_search_requests: 1 } },
    },
    { type: "message_stop" },
  ];
}

/** Un `fetch` falso que contesta con estos eventos SSE y guarda lo que se le mandó. */
function fetchConSse(eventos: object[], cuerpos: any[]): typeof fetch {
  const sse = eventos.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return (async (_url: unknown, init?: RequestInit) => {
    cuerpos.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response(new TextEncoder().encode(sse), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
}

type Vuelta = { stop: StopReason; content: ContentBlock[] };

/** Proveedor falso: una respuesta por vuelta, en orden. Guarda lo que se le mandó. */
function proveedor(vueltas: Vuelta[]): { provider: ModelProvider; llamadas: Message[][] } {
  const llamadas: Message[][] = [];
  const provider: ModelProvider = {
    name: "anthropic",
    defaultModel: "claude-sonnet-5-5",
    async stream(params): Promise<Extract<StreamEvent, { type: "end" }>> {
      llamadas.push(JSON.parse(JSON.stringify(params.messages)));
      const v = vueltas[llamadas.length - 1];
      if (!v) throw new Error(`el guion no tiene vuelta ${llamadas.length - 1}`);
      return { type: "end", stopReason: v.stop, message: { role: "assistant", content: v.content }, usage: { inputTokens: 0, outputTokens: 10 } };
    },
  };
  return { provider, llamadas };
}

const crudo = (bloque: Record<string, unknown>): ContentBlock => ({ type: "crudo", bloque });

function capturaFalsa() {
  return { ok: true as const, titulo: "x", enBlanco: false, overlay: "", errores: [], alto: 800, altoTotal: 800, imagen: "AAAA" };
}

async function main() {
  console.log("=== El agente busca en internet ===\n");
  const dir = await mkdtemp(join(tmpdir(), "multi-internet-"));
  const base = { workspaceDir: dir, runner: localRunner(dir), messages: [] as Message[], userMessage: "haz una página del ciclo del agua" };
  const original = globalThis.fetch;

  try {
    console.log("1. Anthropic: la búsqueda llega como bloques crudos");
    let primero: Message | undefined;
    {
      const cuerpos: any[] = [];
      globalThis.fetch = fetchConSse(sseDeBusqueda(), cuerpos);
      const vistas: { name: string; input: Record<string, unknown> }[] = [];
      const fin = await new AnthropicProvider("sk-falsa").stream(
        { messages: [{ role: "user", content: [{ type: "text", text: "hola" }] }], tools: [] },
        { onServerTool: (i) => vistas.push(i) },
      );
      primero = fin.message;
      const tipos = fin.message.content.map((c) => (c.type === "crudo" ? String(c.bloque.type) : c.type));
      check("en orden: texto, llamada, resultado, texto", tipos.join(",") === "text,server_tool_use,web_search_tool_result,text", tipos.join(","));
      const uso = fin.message.content.find((c) => c.type === "crudo" && c.bloque.type === "server_tool_use");
      check(
        "la llamada trae su input armado de los deltas",
        uso?.type === "crudo" && JSON.stringify(uso.bloque) === JSON.stringify(USO),
        JSON.stringify(uso),
      );
      check("se avisa a la sala con la query", vistas.length === 1 && vistas[0]?.input.query === "ciclo del agua wikimedia", JSON.stringify(vistas));
      check("el uso cuenta la búsqueda", fin.usage?.busquedas === 1, JSON.stringify(fin.usage));
      check("termina normal", fin.stopReason === "end_turn", fin.stopReason);
      check("sin tools propias no se mandan las de internet", cuerpos[0]?.tools === undefined, JSON.stringify(cuerpos[0]?.tools));
    }

    console.log("\n2. En la siguiente llamada vuelven idénticos");
    {
      const cuerpos: any[] = [];
      globalThis.fetch = fetchConSse(sseDeBusqueda(), cuerpos);
      const tool = { name: "bash", description: "x", input_schema: { type: "object" as const, properties: {} } };
      await new AnthropicProvider("sk-falsa").stream({
        messages: [{ role: "user", content: [{ type: "text", text: "hola" }] }, primero!, { role: "user", content: [{ type: "text", text: "¿y?" }] }],
        tools: [tool],
      });
      const enviado = cuerpos[0]?.messages?.[1]?.content ?? [];
      check("la llamada va byte por byte igual", JSON.stringify(enviado[1]) === JSON.stringify(USO), JSON.stringify(enviado[1]));
      check("el resultado (con encrypted_content) también", JSON.stringify(enviado[2]) === JSON.stringify(RESULTADO), JSON.stringify(enviado[2]));
      const tools: any[] = cuerpos[0]?.tools ?? [];
      check("las tools propias van primero", tools[0]?.name === "bash", JSON.stringify(tools[0]));
      check(
        "y al final buscar y leer, con filtrado en Sonnet 5.5",
        tools[1]?.type === "web_search_20260318" && tools[2]?.type === "web_fetch_20260318",
        JSON.stringify(tools.slice(1)),
      );
      check("con topes", tools[1]?.max_uses === 5 && tools[2]?.max_uses === 5 && tools[2]?.max_content_tokens === 20000);
    }

    console.log("\n3. La versión de las herramientas depende del modelo");
    {
      const tipos = (m: string) => herramientasWeb(m).map((t) => t.type).join(",");
      check("Haiku 4.5 → básicas", tipos("claude-haiku-4-5-20251001") === "web_search_20250305,web_fetch_20250910", tipos("claude-haiku-4-5-20251001"));
      check("Opus 5 → con filtrado", tipos("claude-opus-5") === "web_search_20260318,web_fetch_20260318", tipos("claude-opus-5"));
      check("Sonnet 4.6 → con filtrado", tipos("claude-sonnet-4-6") === "web_search_20260318,web_fetch_20260318", tipos("claude-sonnet-4-6"));
      check("Sonnet 4.5 → básicas", tipos("claude-sonnet-4-5") === "web_search_20250305,web_fetch_20250910", tipos("claude-sonnet-4-5"));
      check("un nombre raro → básicas", tipos("mi-modelo") === "web_search_20250305,web_fetch_20250910", tipos("mi-modelo"));
      check("las básicas no llevan response_inclusion", herramientasWeb("claude-haiku-4-5").every((t) => !("response_inclusion" in t)));
    }

    console.log("\n4. Una pausa se retoma sin mensaje nuevo, en el mismo mensaje");
    {
      const { provider, llamadas } = proveedor([
        { stop: "pause_turn", content: [{ type: "text", text: "Busco." }, crudo(USO)] },
        { stop: "end_turn", content: [crudo(RESULTADO), { type: "text", text: "Ya está la página." }] },
      ]);
      const r = await runAgent({ ...base, provider });
      check("dos llamadas", llamadas.length === 2, `${llamadas.length}`);
      const segunda = llamadas[1] ?? [];
      check("la segunda termina con el assistant pausado, sin usuario nuevo", segunda.at(-1)?.role === "assistant", segunda.at(-1)?.role);
      check("y lo pausado va tal cual", JSON.stringify(segunda.at(-1)?.content) === JSON.stringify([{ type: "text", text: "Busco." }, crudo(USO)]));
      check("la respuesta final junta los dos textos", r.finalText === "Busco.Ya está la página.", r.finalText);
      check("un solo assistant en lo guardado", r.messages.filter((m) => m.role === "assistant").length === 1);
    }

    console.log("\n5. Pausada más de tres veces, se cierra");
    {
      const pausa: Vuelta = { stop: "pause_turn", content: [crudo(USO)] };
      const { provider, llamadas } = proveedor([pausa, pausa, pausa, pausa, { stop: "end_turn", content: [{ type: "text", text: "no" }] }]);
      const r = await runAgent({ ...base, provider });
      check("cuatro llamadas y para", llamadas.length === 4, `${llamadas.length}`);
      check("lo guardado no deja la búsqueda colgada", !r.messages.some(servidorPendiente));
    }

    console.log("\n6. Búsqueda junto con una tool nuestra: ahí solo van tool_result");
    {
      const { provider, llamadas } = proveedor([
        {
          stop: "tool_use",
          content: [
            crudo(USO),
            { type: "tool_use", id: "tu_1", name: "ver_preview", input: {} },
          ],
        },
        { stop: "tool_use", content: [crudo(RESULTADO), { type: "tool_use", id: "tu_2", name: "read_file", input: { path: "nada.txt" } }] },
        { stop: "end_turn", content: [{ type: "text", text: "Listo." }] },
      ]);
      await runAgent({ ...base, provider, verPreview: async () => capturaFalsa(), ve: true });
      const resultados = llamadas[1]?.at(-1);
      check("detecta la búsqueda pendiente", servidorPendiente({ role: "assistant", content: [crudo(USO)] }));
      check("y no cuando ya trae su resultado", !servidorPendiente({ role: "assistant", content: [crudo(USO), crudo(RESULTADO)] }));
      check(
        "el mensaje que sigue solo lleva tool_result",
        resultados?.role === "user" && resultados.content.every((c) => c.type === "tool_result"),
        JSON.stringify(resultados?.content.map((c) => c.type)),
      );
      const siguiente = llamadas[2]?.at(-1);
      check(
        "la captura llega con los siguientes resultados",
        siguiente?.role === "user" && siguiente.content.some((c) => c.type === "image"),
        JSON.stringify(siguiente?.content.map((c) => c.type)),
      );
    }

    console.log("\n7. Lo que se guarda conserva las búsquedas, salvo las colgadas");
    {
      const historial: Message[] = [
        { role: "user", content: [{ type: "text", text: "busca" }] },
        { role: "assistant", content: [{ type: "text", text: "Busco." }, crudo(USO), crudo(RESULTADO), { type: "text", text: "Listo." }] },
        { role: "user", content: [{ type: "text", text: "otra" }] },
        { role: "assistant", content: [{ type: "text", text: "Busco otra." }, crudo(USO)] },
      ];
      const limpio = sinBusquedasColgadas(historial);
      check("una búsqueda completa se queda tal cual", JSON.stringify(limpio[1]) === JSON.stringify(historial[1]));
      const colgada = (limpio[3]?.content ?? []).map((c) => (c.type === "text" ? c.text : c.type));
      check("la colgada se quita y deja una nota", colgada.length === 2 && colgada[0] === "Busco otra." && colgada[1]!.includes("“ciclo del agua wikimedia”"), JSON.stringify(colgada));
      check("ya no queda ninguna colgada", !limpio.some(servidorPendiente));
      check("no toca el original", historial[3]!.content.length === 2);

      const { provider } = proveedor([
        { stop: "end_turn", content: [{ type: "text", text: "Busco." }, crudo(USO), crudo(RESULTADO), { type: "text", text: "Listo." }] },
      ]);
      const r = await runAgent({ ...base, provider });
      check("runAgent guarda la búsqueda completa", r.messages.some((m) => m.content.some((c) => c.type === "crudo" && c.bloque.type === "web_search_tool_result")));
    }

    console.log("\n8. La sala lo cuenta como lo diría una persona");
    {
      // Así llega de verdad con Sonnet 5.5: la búsqueda va dentro del código del filtrado.
      const codigo = 'r = await web_search({"query": "población Ciudad de México \\"censo\\" 2020"})\np = await web_fetch({"url": "https://www.inegi.org.mx/x.pdf"})';
      const dentro = busquedasEn("code_execution", { code: codigo });
      check(
        "saca la búsqueda y la lectura del código del filtrado",
        dentro.length === 2 && dentro[0]?.name === "web_search" && dentro[0]?.input.query === 'población Ciudad de México "censo" 2020' && dentro[1]?.input.url === "https://www.inegi.org.mx/x.pdf",
        JSON.stringify(dentro),
      );
      check("código sin búsquedas no enseña nada", busquedasEn("code_execution", { code: "print(r)" }).length === 0);
      check("una llamada directa pasa tal cual", busquedasEn("web_search", { query: "x" })[0]?.input.query === "x");
      const nota = sinBusquedasColgadas([{ role: "assistant", content: [crudo({ type: "server_tool_use", id: "s", name: "code_execution", input: { code: codigo } })] }]);
      check("y la nota del historial también lo dice", JSON.stringify(nota).includes("censo") && JSON.stringify(nota).includes("inegi.org.mx"), JSON.stringify(nota));

      const busca = accionDeTool("web_search", { query: "ciclo del agua" });
      check("buscar", busca.tipo === "buscarWeb" && busca.detalle === "ciclo del agua", JSON.stringify(busca));
      const lee = accionDeTool("web_fetch", { url: "https://www.es.wikipedia.org/wiki/Ciclo_del_agua" });
      check("leer, con el sitio sin www", lee.tipo === "leerWeb" && lee.archivo === "es.wikipedia.org", JSON.stringify(lee));
    }
  } finally {
    globalThis.fetch = original;
    await rm(dir, { recursive: true, force: true });
  }

  console.log(`\n${pass} ok, ${fail} fallaron`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
