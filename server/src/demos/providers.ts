import { createServer } from "node:http";
import { OpenAICompatProvider } from "../agent/providers/openai-compat.js";
import type { Message, ToolSpec } from "../agent/providers/types.js";

/**
 * Demo: el cliente del formato OpenAI (OpenRouter, OpenAI, Groq, Ollama…).
 * Uso: npm run demo:providers
 *
 * Levanta un servidor falso que responde SSE como lo haría el proveedor real, y
 * verifica las dos mitades: que MANDAMOS bien la petición (mensajes y tools
 * traducidos) y que LEEMOS bien la respuesta (texto en deltas, tool_calls
 * partidos por índice, finish_reason).
 *
 * No usa red ni API key: prueba la traducción de formatos, que es donde de
 * verdad se rompe un provider.
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

/** Servidor que responde con los chunks SSE que le des. */
function servidorFalso(chunks: string[]): Promise<{ url: string; recibido: () => any; cerrar: () => void }> {
  let body: any = null;
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        body = JSON.parse(raw);
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const c of chunks) res.write(`data: ${c}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        recibido: () => body,
        cerrar: () => server.close(),
      });
    });
  });
}

const TOOL: ToolSpec = {
  name: "write_file",
  description: "Escribe un archivo",
  input_schema: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path"],
  },
};

function chunk(delta: any, finish: string | null = null): string {
  return JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] });
}

async function main() {
  console.log("=== Provider compatible con OpenAI ===\n");

  console.log("1. El texto llega en deltas y se concatena");
  {
    const s = await servidorFalso([
      chunk({ content: "Voy a " }),
      chunk({ content: "escribir " }),
      chunk({ content: "el archivo." }),
      chunk({}, "stop"),
    ]);
    const p = new OpenAICompatProvider({
      apiKey: "test",
      baseUrl: s.url,
      defaultModel: "modelo-x",
      name: "Falso",
    });

    let streamed = "";
    const end = await p.stream(
      { messages: [{ role: "user", content: [{ type: "text", text: "hola" }] }] },
      { onText: (d) => (streamed += d) },
    );

    check("el texto se arma completo", streamed === "Voy a escribir el archivo.", streamed);
    check("termina como end_turn", end.stopReason === "end_turn", end.stopReason);
    check(
      "el mensaje del assistant trae el texto",
      end.message.content[0]?.type === "text",
      JSON.stringify(end.message.content[0]),
    );
    s.cerrar();
  }

  console.log("\n2. Un tool_call partido en varios chunks se reensambla");
  {
    // Así llega de verdad: el nombre en un chunk, los argumentos en pedazos.
    const s = await servidorFalso([
      chunk({ tool_calls: [{ index: 0, id: "call_1", function: { name: "write_file" } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"path":"src/' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'App.jsx","content":"hola"}' } }] }),
      chunk({}, "tool_calls"),
    ]);
    const p = new OpenAICompatProvider({
      apiKey: "test",
      baseUrl: s.url,
      defaultModel: "modelo-x",
      name: "Falso",
    });

    const end = await p.stream({
      messages: [{ role: "user", content: [{ type: "text", text: "escribe" }] }],
      tools: [TOOL],
    });

    const uso = end.message.content.find((c) => c.type === "tool_use") as any;
    check("detecta el tool_use", !!uso);
    check("con su nombre", uso?.name === "write_file", uso?.name);
    check("y los argumentos completos", uso?.input?.path === "src/App.jsx", JSON.stringify(uso?.input));
    check("termina como tool_use", end.stopReason === "tool_use", end.stopReason);
    s.cerrar();
  }

  console.log("\n3. Dos tool_calls en paralelo, mezclados por índice");
  {
    const s = await servidorFalso([
      chunk({ tool_calls: [{ index: 0, id: "a", function: { name: "read_file", arguments: '{"path":' } }] }),
      chunk({ tool_calls: [{ index: 1, id: "b", function: { name: "read_file", arguments: '{"path":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"uno.js"}' } }] }),
      chunk({ tool_calls: [{ index: 1, function: { arguments: '"dos.js"}' } }] }),
      chunk({}, "tool_calls"),
    ]);
    const p = new OpenAICompatProvider({
      apiKey: "test",
      baseUrl: s.url,
      defaultModel: "modelo-x",
      name: "Falso",
    });

    const end = await p.stream({
      messages: [{ role: "user", content: [{ type: "text", text: "lee" }] }],
      tools: [TOOL],
    });
    const usos = end.message.content.filter((c) => c.type === "tool_use") as any[];
    check("salen los dos", usos.length === 2, `salieron ${usos.length}`);
    check("sin mezclarse", usos[0]?.input?.path === "uno.js" && usos[1]?.input?.path === "dos.js",
      JSON.stringify(usos.map((u) => u.input)));
    s.cerrar();
  }

  console.log("\n4. Lo que MANDAMOS está en su formato");
  {
    const s = await servidorFalso([chunk({ content: "ok" }, "stop")]);
    const p = new OpenAICompatProvider({
      apiKey: "test",
      baseUrl: s.url,
      defaultModel: "modelo-x",
      name: "Falso",
    });

    // Una conversación con tool_use y su resultado: el caso que más se rompe.
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "escribe algo" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "va" },
          { type: "tool_use", id: "call_9", name: "write_file", input: { path: "a.js" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_9", content: "escrito" }],
      },
    ];

    await p.stream({ system: "eres un agente", messages, tools: [TOOL] });
    const body = s.recibido();

    check("va el system como primer mensaje", body.messages[0]?.role === "system", body.messages[0]?.role);
    check("el tool_use viaja como tool_calls", !!body.messages[2]?.tool_calls, JSON.stringify(body.messages[2]));
    check(
      "los argumentos van como string JSON",
      typeof body.messages[2]?.tool_calls?.[0]?.function?.arguments === "string",
    );
    check(
      "el resultado va como role tool",
      body.messages[3]?.role === "tool" && body.messages[3]?.tool_call_id === "call_9",
      JSON.stringify(body.messages[3]),
    );
    check(
      "las tools van en formato function",
      body.tools?.[0]?.type === "function" && body.tools?.[0]?.function?.name === "write_file",
      JSON.stringify(body.tools?.[0]),
    );
    check("pide el conteo de tokens", body.stream_options?.include_usage === true);
    s.cerrar();
  }

  console.log("\n5. Argumentos inválidos no tumban el turno");
  {
    const s = await servidorFalso([
      chunk({ tool_calls: [{ index: 0, id: "x", function: { name: "write_file", arguments: "{roto" } }] }),
      chunk({}, "tool_calls"),
    ]);
    const p = new OpenAICompatProvider({
      apiKey: "test",
      baseUrl: s.url,
      defaultModel: "modelo-x",
      name: "Falso",
    });
    const end = await p.stream({
      messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
      tools: [TOOL],
    });
    const uso = end.message.content.find((c) => c.type === "tool_use") as any;
    check("sigue habiendo tool_use", !!uso);
    check("con input vacío en vez de reventar", JSON.stringify(uso?.input) === "{}", JSON.stringify(uso?.input));
    s.cerrar();
  }

  console.log(`\n${pass} pasaron, ${fail} fallaron\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("falló:", e);
  process.exit(1);
});
