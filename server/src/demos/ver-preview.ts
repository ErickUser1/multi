import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent, CAPTURA_RETIRADA } from "../agent/loop.js";
import { localRunner } from "../engine/runner.js";
import { capturarPreview } from "../engine/captura.js";
import { verPreviewTool, MAX_CAPTURAS_POR_TURNO, type Captura } from "../agent/tools/ver-preview.js";
import { ToolError, type ToolContext } from "../agent/tools/base.js";
import { AnthropicProvider } from "../agent/providers/anthropic.js";
import { OpenAICompatProvider } from "../agent/providers/openai-compat.js";
import type { ContentBlock, Message, ModelProvider, StreamEvent } from "../agent/providers/types.js";

/**
 * Demo: el agente mira su propia vista previa.
 * Uso: npm run demo:ver-preview
 *
 * Lo que cubre: en las sesiones reales el agente decía "listo" sin haber visto
 * nada, y la pantalla en blanco o el error rojo de Vite los descubría la
 * persona. Aquí se prueba que el navegador ve lo que hay (errores, blanco, el
 * overlay), que la captura llega al modelo en el formato de cada proveedor, y
 * que no se queda pagándose en el historial.
 *
 * Necesita Chromium (el de Playwright: `npx playwright-core install chromium`).
 * No necesita Docker, red ni API key: corre sin contenedor, como una sala sin
 * aislar, y los proveedores reciben un `fetch` falso.
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

const PAGINAS: Record<string, string> = {
  "/": "<!doctype html><meta charset=utf-8><title>Tienda</title><h1>Hola 👋</h1><p>Todo bien.</p>",
  "/rota":
    "<!doctype html><meta charset=utf-8><title>Rota</title><h1>Casi</h1><script>throw new Error('App is not defined')</script>",
  "/blanca": "<!doctype html><meta charset=utf-8><title>Vacía</title><div id=root></div><script type=module src=/no-existe.js></script>",
  // Lo que pinta Vite cuando el código no compila: un elemento con su shadow root.
  "/overlay": `<!doctype html><meta charset=utf-8><title>Overlay</title><script>
    customElements.define('vite-error-overlay', class extends HTMLElement {
      constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<pre>[plugin:vite:import-analysis] Failed to resolve import "./App" from "src/main.tsx"</pre>'; }
    });
    document.addEventListener('DOMContentLoaded', () => document.body.appendChild(document.createElement('vite-error-overlay')));
  </script>`,
  // Como una diapositiva con fotos: la captura pesa cientos de KB. Con estas
  // el JSON llegaba cortado en 80 KB y la tool reportaba error.
  "/pesada": `<!doctype html><meta charset=utf-8><title>Pesada</title><body style="margin:0"><canvas id=c width=1280 height=800></canvas><script>
    const c = document.getElementById('c').getContext('2d'); const d = c.createImageData(1280, 800);
    for (let i = 0; i < d.data.length; i++) d.data[i] = Math.random() * 255; c.putImageData(d, 0, 0);
  </script>`,
  "/larga": `<!doctype html><meta charset=utf-8><title>Larga</title><div style="height:3000px;background:linear-gradient(#fff,#f60)">arriba</div>`,
};

function servidor(): Promise<{ server: Server; base: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const html = PAGINAS[req.url ?? ""];
      if (!html) {
        res.writeHead(404).end("no");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
    });
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      resolve({ server, base: `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}` });
    });
  });
}

const IMAGEN_FALSA = Buffer.from("no es un jpeg de verdad").toString("base64");
const capturaFalsa = (extra: Partial<Extract<Captura, { ok: true }>> = {}): Captura => ({
  ok: true,
  titulo: "App",
  enBlanco: false,
  overlay: "",
  errores: [],
  alto: 800,
  altoTotal: 800,
  imagen: IMAGEN_FALSA,
  ...extra,
});

/** Un proveedor falso que pide ver_preview N veces y luego termina. Guarda lo que recibió. */
function proveedorQueMira(veces: number): { provider: ModelProvider; llamadas: Message[][] } {
  const llamadas: Message[][] = [];
  const provider: ModelProvider = {
    name: "falso",
    defaultModel: "falso/modelo",
    async stream(params): Promise<Extract<StreamEvent, { type: "end" }>> {
      llamadas.push(JSON.parse(JSON.stringify(params.messages)));
      const n = llamadas.length;
      const content: ContentBlock[] =
        n <= veces
          ? [{ type: "tool_use", id: `tu_${n}`, name: "ver_preview", input: {} }]
          : [{ type: "text", text: "Ya quedó, lo revisé." }];
      return {
        type: "end",
        stopReason: n <= veces ? "tool_use" : "end_turn",
        message: { role: "assistant", content },
      };
    },
  };
  return { provider, llamadas };
}

/** Capturas en el historial: imágenes que van junto a resultados de tools. */
function imagenesEn(msgs: Message[]): number {
  return msgs.reduce(
    (n, m) => n + (m.content.some((c) => c.type === "tool_result") ? m.content.filter((c) => c.type === "image").length : 0),
    0,
  );
}

const avisosEn = (msgs: Message[]) =>
  msgs.flatMap((m) => m.content).filter((c) => c.type === "text" && c.text === CAPTURA_RETIRADA).length;

/** Un fetch falso que guarda el cuerpo pedido y contesta con este SSE. */
function fetchQueGuarda(cuerpos: unknown[], sse: string): typeof fetch {
  return (async (_url: unknown, init?: { body?: unknown }) => {
    cuerpos.push(JSON.parse(String(init?.body)));
    return new Response(new TextEncoder().encode(sse), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
}

const HISTORIAL_CON_CAPTURA: Message[] = [
  { role: "user", content: [{ type: "text", text: "haz la tienda" }] },
  { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "ver_preview", input: {} }] },
  {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "tu_1", content: "sin errores" },
      { type: "image", mediaType: "image/jpeg", data: IMAGEN_FALSA },
    ],
  },
];

async function main() {
  console.log("=== El agente mira su vista previa ===\n");
  const { server, base } = await servidor();
  const dir = await mkdtemp(join(tmpdir(), "multi-ver-preview-"));
  const runner = localRunner(dir);
  const ver = (ruta: string, extra: { ancho?: number; alto?: number; completa?: boolean } = {}) =>
    capturarPreview(runner, base, { ruta, ancho: extra.ancho ?? 1280, alto: extra.alto ?? 800, completa: extra.completa ?? false });

  try {
    console.log("1. El navegador ve lo que hay");
    {
      const sana = await ver("/");
      check("abre la página sana", sana.ok, sana.ok ? "" : sana.error);
      if (sana.ok) {
        check("trae una captura JPEG", Buffer.from(sana.imagen, "base64").subarray(0, 2).toString("hex") === "ffd8");
        check("sin errores", sana.errores.length === 0, sana.errores.join(" | "));
        check("no está en blanco", !sana.enBlanco);
        check("lee el título", sana.titulo === "Tienda", sana.titulo);
      }

      const rota = await ver("/rota");
      check("ve la excepción", rota.ok && rota.errores.some((e) => e.includes("App is not defined")), JSON.stringify(rota.ok && rota.errores));

      const blanca = await ver("/blanca");
      check("se da cuenta de que está en blanco", blanca.ok && blanca.enBlanco);
      check("y de lo que no cargó", blanca.ok && blanca.errores.some((e) => e.includes("/no-existe.js")), JSON.stringify(blanca.ok && blanca.errores));

      const overlay = await ver("/overlay");
      check("lee el error de compilación de Vite", overlay.ok && overlay.overlay.includes("Failed to resolve import"), overlay.ok ? overlay.overlay : "");
      check("y con el overlay no cuenta como en blanco", overlay.ok && !overlay.enBlanco);

      const celular = await ver("/larga", { ancho: 390, alto: 844 });
      check("la captura normal es una pantalla", celular.ok && celular.alto === 844, String(celular.ok && celular.alto));
      check("pero sabe cuánto mide la página", celular.ok && celular.altoTotal >= 3000, String(celular.ok && celular.altoTotal));
      const pesada = await ver("/pesada");
      check(
        "una captura pesada (con fotos) llega completa",
        pesada.ok && pesada.imagen.length > 200_000,
        pesada.ok ? `${Math.round(pesada.imagen.length / 1024)} KB` : pesada.error.slice(0, 80),
      );
      const completa = await ver("/larga", { completa: true });
      check("completa llega hasta el tope de 2400", completa.ok && completa.alto === 2400, String(completa.ok && completa.alto));
    }

    console.log("\n2. La tool: qué le cuenta al modelo");
    {
      const pedidos: unknown[] = [];
      const ctx: ToolContext = {
        workspaceDir: dir,
        runner,
        verPreview: async (p) => {
          pedidos.push(p);
          return capturaFalsa({ enBlanco: true, errores: ["excepción: boom"] });
        },
      };
      const r = await verPreviewTool.run({ dispositivo: "celular", ruta: "carrito" }, ctx);
      check("devuelve la imagen", r.imagen?.data === IMAGEN_FALSA);
      check("lo malo va en el texto", r.texto.includes("SE VE EN BLANCO") && r.texto.includes("boom"), r.texto);
      check("pide el tamaño de celular y la ruta con /", JSON.stringify(pedidos[0]).includes('"ruta":"/carrito"') && JSON.stringify(pedidos[0]).includes('"ancho":390'));

      for (let i = 1; i < MAX_CAPTURAS_POR_TURNO; i++) await verPreviewTool.run({}, ctx);
      let tope = "";
      await verPreviewTool.run({}, ctx).catch((e) => (tope = e instanceof ToolError ? e.message : String(e)));
      check(`a la ${MAX_CAPTURAS_POR_TURNO + 1}ª dice que ya no`, tope.includes("ya miraste"), tope);

      let sinPreview = "";
      await verPreviewTool
        .run({}, { workspaceDir: dir, runner, verPreview: async () => null })
        .catch((e) => (sinPreview = String(e.message)));
      check("sin vista previa corriendo lo dice claro", sinPreview.includes("no hay vista previa corriendo"), sinPreview);

      let url = "";
      await verPreviewTool
        .run({ ruta: "https://otro.com" }, { workspaceDir: dir, runner, verPreview: async () => capturaFalsa() })
        .catch((e) => (url = String(e.message)));
      check("no abre URLs de afuera", url.includes("no una URL"), url);
    }

    console.log("\n3. En el loop: solo la última captura viaja, y ninguna se guarda");
    {
      const { provider, llamadas } = proveedorQueMira(3);
      const r = await runAgent({
        provider,
        workspaceDir: dir,
        runner,
        messages: [],
        userMessage: "haz la tienda",
        verPreview: async () => capturaFalsa(),
        ve: true,
      });
      check("miró tres veces y terminó", llamadas.length === 4 && r.finalText === "Ya quedó, lo revisé.", `${llamadas.length}`);
      check("cada llamada lleva UNA imagen, la más reciente", llamadas.slice(1).every((m) => imagenesEn(m) === 1), llamadas.map(imagenesEn).join(","));
      const ultima = llamadas[3]!;
      check("la que tiene imagen es la última", ultima.at(-1)!.content.some((c) => c.type === "image"));
      check("las de antes dejan un aviso en su lugar", avisosEn(ultima) === 2, String(avisosEn(ultima)));
      check("la imagen va después del tool_result", ultima.at(-1)!.content[0]?.type === "tool_result");
      check("el historial que se guarda no tiene ninguna", imagenesEn(r.messages) === 0 && avisosEn(r.messages) === 3);

      // Las imágenes que pega la gente no son capturas: no se tocan.
      const pegada: Message = { role: "user", content: [{ type: "image", mediaType: "image/png", data: "x" }, { type: "text", text: "pon este logo" }] };
      const conPegada = proveedorQueMira(2);
      await runAgent({
        provider: conPegada.provider,
        workspaceDir: dir,
        runner,
        messages: [pegada, { role: "assistant", content: [{ type: "text", text: "va" }] }],
        userMessage: "revisa",
        verPreview: async () => capturaFalsa(),
        ve: true,
      });
      check("una imagen pegada en el chat no se confunde con una captura", conPegada.llamadas[2]![0]!.content[0]?.type === "image");

      const sinVer = proveedorQueMira(1);
      await runAgent({
        provider: sinVer.provider,
        workspaceDir: dir,
        runner,
        messages: [],
        userMessage: "haz la tienda",
        verPreview: async () => capturaFalsa({ errores: ["excepción: boom"] }),
        ve: false,
      });
      const res = sinVer.llamadas[1]!.flatMap((m) => m.content).find((c) => c.type === "tool_result");
      check("a un modelo que no ve no le llega la imagen", imagenesEn(sinVer.llamadas[1]!) === 0);
      check("pero sí el texto con los errores", res?.type === "tool_result" && res.content.includes("boom"));
    }

    console.log("\n4. Cada proveedor la recibe en su formato");
    {
      const original = globalThis.fetch;
      try {
        const cuerpos: any[] = [];
        globalThis.fetch = fetchQueGuarda(
          cuerpos,
          [
            { type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 0 } } },
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
            { type: "content_block_stop", index: 0 },
            { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
            { type: "message_stop" },
          ]
            .map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`)
            .join(""),
        );
        await new AnthropicProvider("sk-falsa").stream({ messages: HISTORIAL_CON_CAPTURA });
        const [tr, img] = cuerpos[0].messages[2].content;
        check("Anthropic: primero el tool_result", tr?.type === "tool_result" && tr.content === "sin errores", JSON.stringify(tr).slice(0, 120));
        check("Anthropic: y la imagen después, en el mismo mensaje", img?.type === "image" && img.source?.data === IMAGEN_FALSA);

        const cuerposOa: any[] = [];
        globalThis.fetch = fetchQueGuarda(
          cuerposOa,
          `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        );
        await new OpenAICompatProvider({ apiKey: "x", baseUrl: "http://falso", defaultModel: "m", name: "OpenAI" }).stream({
          messages: HISTORIAL_CON_CAPTURA,
        });
        const msgs = cuerposOa[0].messages as any[];
        const iTool = msgs.findIndex((m) => m.role === "tool");
        check("OpenAI: el mensaje tool lleva solo el texto", msgs[iTool]?.content === "sin errores", JSON.stringify(msgs[iTool]));
        check(
          "OpenAI: la imagen va en un user justo después",
          msgs[iTool + 1]?.role === "user" && msgs[iTool + 1].content.some((p: any) => p.type === "image_url"),
          JSON.stringify(msgs[iTool + 1])?.slice(0, 120),
        );
      } finally {
        globalThis.fetch = original;
      }
    }
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }

  console.log(`\n${pass} pasaron, ${fail} fallaron`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
