import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configVertex, crearProveedorVertex, obtenerTokenDe, olvidarTokensDeVertex, urlDeVertex } from "../agent/providers/vertex.js";
import { ConRespaldo, MINUTOS_EN_RESPALDO, esSinSaldo, reiniciarRespaldo } from "../agent/providers/con-respaldo.js";
import { ProviderError, type Message, type ModelProvider, type StreamEvent, type StreamParams } from "../agent/providers/types.js";

/**
 * Demo: el respaldo con Gemini en Vertex.
 * Uso: npm run demo:respaldo-gemini
 *
 * El 29 de octubre seis personas construían un juego en una sala y a media
 * tarde "Multti se quedó sin saldo". Con esto la sala sigue con Gemini, pagado
 * con los créditos de Google. Lo que se revisa:
 *   1. La configuración del `.env`.
 *   2. El permiso de Google: se renueva solo, se cachea, y falla claro.
 *   3. Las firmas de Gemini: llegan en el stream, se guardan, y se regresan.
 *   4. El cambio: sin saldo, la misma vuelta sigue con Gemini, y regresa a
 *      Claude pasado el rato.
 *
 * Sin red: `fetch` falso que contesta como Google.
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

const sse = (chunks: object[]) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";

type Llamada = { url: string; headers: Record<string, string>; body: string };

/** Un `fetch` falso: el de OAuth de Google y el de Vertex. */
function fetchDeGoogle(respuestasVertex: string[], llamadas: Llamada[], token = { n: 0 }): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    llamadas.push({ url: u, headers: Object.fromEntries(new Headers(init?.headers).entries()), body: String(init?.body ?? "") });
    if (u.startsWith("https://oauth2.googleapis.com/token")) {
      token.n++;
      return new Response(JSON.stringify({ access_token: `tok-${token.n}`, expires_in: 3600 }), { status: 200 });
    }
    const cuerpo = respuestasVertex.shift() ?? sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]);
    return new Response(cuerpo, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
}

/** Un proveedor falso que contesta o truena, y cuenta cuántas veces lo llamaron. */
function falso(nombre: string, hacer: (p: StreamParams) => Extract<StreamEvent, { type: "end" }> | Error) {
  const llamadas: StreamParams[] = [];
  const provider: ModelProvider = {
    name: nombre,
    defaultModel: `${nombre}/modelo`,
    async stream(p) {
      llamadas.push(p);
      const r = hacer(p);
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return { provider, llamadas };
}
const listo = (texto: string): Extract<StreamEvent, { type: "end" }> => ({
  type: "end",
  stopReason: "end_turn",
  message: { role: "assistant", content: [{ type: "text", text: texto }] },
});

async function main() {
  console.log("=== Respaldo con Gemini en Vertex ===\n");
  const original = globalThis.fetch;
  const dir = await mkdtemp(join(tmpdir(), "multi-vertex-"));
  const adc = join(dir, "adc.json");
  await writeFile(adc, JSON.stringify({ type: "authorized_user", refresh_token: "r", client_id: "c", client_secret: "s" }));

  try {
    console.log("1. La configuración");
    check("sin VERTEX_PROJECT no hay respaldo", configVertex({}) === null && crearProveedorVertex({}) === null);
    const c = configVertex({ VERTEX_PROJECT: "mi-proyecto" });
    check("con proyecto, el modelo de entrada", c?.modelo === "gemini-4-argon" && c?.region === "global", JSON.stringify(c));
    check("las credenciales, en el lugar de gcloud", c?.credenciales.endsWith(".config/gcloud/application_default_credentials.json") === true);
    check(
      "la URL global",
      urlDeVertex({ proyecto: "p", region: "global" }) === "https://aiplatform.googleapis.com/v1/projects/p/locations/global/endpoints/openapi",
    );
    check("y la de una región", urlDeVertex({ proyecto: "p", region: "us-central1" }).startsWith("https://us-central1-aiplatform.googleapis.com/"));

    console.log("\n2. El permiso de Google se renueva solo");
    {
      olvidarTokensDeVertex();
      const llamadas: Llamada[] = [];
      let reloj = 1_000_000;
      globalThis.fetch = fetchDeGoogle([], llamadas);
      const token = obtenerTokenDe(adc, () => reloj);
      check("pide un token con el refresh token", (await token()) === "tok-1" && llamadas[0]?.body.includes("grant_type=refresh_token"));
      await token();
      check("y lo cachea", llamadas.length === 1, String(llamadas.length));
      reloj += 3600_000;
      check("al caducar, pide otro", (await token()) === "tok-2" && llamadas.length === 2);
      olvidarTokensDeVertex();
      llamadas.length = 0;
      const juntos = await Promise.all([token(), token(), token()]);
      check("varias salas a la vez: una sola renovación", llamadas.length === 1 && juntos.every((t) => t === juntos[0]), String(llamadas.length));

      await writeFile(join(dir, "sa.json"), JSON.stringify({ type: "service_account" }));
      let error = "";
      try {
        olvidarTokensDeVertex();
        await obtenerTokenDe(join(dir, "sa.json"))();
      } catch (e) {
        error = String(e);
      }
      check("unas credenciales que no son de usuario se dicen claro", error.includes("application-default login"), error);
      error = "";
      try {
        await obtenerTokenDe(join(dir, "no-existe.json"))();
      } catch (e) {
        error = String(e);
      }
      check("y si no está el archivo, también", error.includes("no se encontró"), error);
    }

    console.log("\n3. Las firmas de Gemini van y vuelven");
    {
      olvidarTokensDeVertex();
      const llamadas: Llamada[] = [];
      const FIRMA = { google: { thought_signature: "AY89a187-firma" } };
      // Así llega de Vertex: la llamada partida en chunks, con la firma en uno.
      globalThis.fetch = fetchDeGoogle(
        [
          sse([
            { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "write_file", arguments: "" } }] } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, extra_content: FIRMA, function: { arguments: '{"path":"hola.txt",' } }] } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"content":"hola"}' } }] }, finish_reason: "tool_calls" }] },
            { usage: { prompt_tokens: 104, completion_tokens: 30 }, choices: [] },
          ]),
        ],
        llamadas,
      );
      const gemini = crearProveedorVertex({ VERTEX_PROJECT: "mi-proyecto", GOOGLE_APPLICATION_CREDENTIALS: adc })!;
      check("se llama como Gemini", gemini.name === "Gemini (Vertex)");
      const fin = await gemini.stream({ messages: [{ role: "user", content: [{ type: "text", text: "crea hola.txt" }] }] });
      const vertex = llamadas.find((l) => l.url.includes("aiplatform"))!;
      check("va a Vertex con el token, no con una key", vertex.headers.authorization === "Bearer tok-1", vertex.headers.authorization);
      check("pide el modelo con su editor", JSON.parse(vertex.body).model === "google/gemini-4-argon");
      check("con techo de salida para archivos grandes", JSON.parse(vertex.body).max_tokens === 32000);
      const tu = fin.message.content.find((b) => b.type === "tool_use");
      check("la llamada llega completa", tu?.type === "tool_use" && tu.input.path === "hola.txt" && tu.input.content === "hola");
      check("con su firma guardada", tu?.type === "tool_use" && JSON.stringify(tu.extra) === JSON.stringify(FIRMA), JSON.stringify(tu));
      check("y el gasto", fin.usage?.inputTokens === 104 && fin.usage?.outputTokens === 30);

      // La vuelta siguiente: la firma tiene que regresar con su llamada.
      const historial: Message[] = [
        { role: "user", content: [{ type: "text", text: "crea hola.txt" }] },
        fin.message,
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "listo" }] },
        // Y una que hizo Claude antes del cambio, sin firma.
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_claude", name: "read_file", input: { path: "a" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_claude", content: "a" }] },
      ];
      llamadas.length = 0;
      await gemini.stream({ messages: historial });
      const mandado = JSON.parse(llamadas.find((l) => l.url.includes("aiplatform"))!.body) as { messages: any[] };
      const propias = mandado.messages.flatMap((m) => m.tool_calls ?? []);
      check("regresa la firma de Gemini tal cual", JSON.stringify(propias[0]?.extra_content) === JSON.stringify(FIRMA), JSON.stringify(propias[0]));
      check(
        "y a la de Claude le pone el comodín de Google",
        propias[1]?.extra_content?.google?.thought_signature === "skip_thought_signature_validator",
        JSON.stringify(propias[1]),
      );
    }

    console.log("\n3b. Los PDFs le llegan a Gemini");
    {
      // Así se perdían: "haz una presentación con este PDF" y el modelo nunca
      // lo recibía, porque el traductor solo mandaba imágenes.
      const llamadas: Llamada[] = [];
      globalThis.fetch = fetchDeGoogle([], llamadas);
      const conPdf: Message[] = [
        {
          role: "user",
          content: [
            { type: "documento", mediaType: "application/pdf", data: "JVBERi0x" },
            { type: "text", text: "haz una presentación con este pdf" },
          ],
        },
      ];
      const gemini = crearProveedorVertex({ VERTEX_PROJECT: "mi-proyecto", GOOGLE_APPLICATION_CREDENTIALS: adc })!;
      await gemini.stream({ messages: conPdf });
      const mandado = JSON.parse(llamadas.find((l) => l.url.includes("aiplatform"))!.body) as { messages: any[] };
      const partes = mandado.messages.find((m) => m.role === "user")?.content;
      check(
        "el PDF va como archivo, con su tipo",
        Array.isArray(partes) && partes[0]?.image_url?.url === "data:application/pdf;base64,JVBERi0x",
        JSON.stringify(partes),
      );
      check("antes del texto", Array.isArray(partes) && partes[1]?.type === "text");

      // Otros proveedores con este formato no lo garantizan: a ellos no.
      llamadas.length = 0;
      const { OpenAICompatProvider } = await import("../agent/providers/openai-compat.js");
      const otro = new OpenAICompatProvider({ apiKey: "k", baseUrl: "https://otro.example/v1", defaultModel: "m", name: "Otro" });
      await otro.stream({ messages: conPdf });
      const aOtro = JSON.parse(llamadas[0]!.body) as { messages: any[] };
      check("a otro proveedor no se le manda", aOtro.messages.find((m) => m.role === "user")?.content === "haz una presentación con este pdf");
    }

    console.log("\n4. Sin saldo, la sala sigue con Gemini");
    {
      reiniciarRespaldo();
      let reloj = 5_000_000;
      let saldo = false;
      const claude = falso("anthropic", () =>
        saldo ? listo("claude") : new ProviderError("400: Your credit balance is too low to access the Anthropic API", "api"),
      );
      const gemini = falso("Gemini (Vertex)", () => listo("gemini"));
      const p = new ConRespaldo(claude.provider, gemini.provider, () => reloj);
      const avisos: string[] = [];
      const r = await p.stream({ messages: [], system: "eres el agente", model: "claude-sonnet-5-5" }, { onRespaldo: ({ proveedor }) => avisos.push(proveedor) });
      check("la misma vuelta sigue con Gemini", r.message.content[0]?.type === "text" && (r.message.content[0] as { text: string }).text === "gemini");
      check("y se avisa", avisos.length === 1 && avisos[0] === "Gemini (Vertex)", JSON.stringify(avisos));
      check("con su modelo, no el de Claude", gemini.llamadas[0]?.model === undefined);
      check("y el prompt le dice que no tiene búsqueda web", gemini.llamadas[0]?.system?.includes("no tienes web_search") === true);
      check("se sigue presentando como el principal", p.name === "anthropic");

      claude.llamadas.length = 0;
      reloj += 60_000;
      await p.stream({ messages: [] });
      check("la vuelta siguiente va directo a Gemini", claude.llamadas.length === 0 && gemini.llamadas.length === 2);

      saldo = true;
      reloj += MINUTOS_EN_RESPALDO * 60_000;
      const vuelta = await p.stream({ messages: [] });
      check(
        `pasados ${MINUTOS_EN_RESPALDO} min regresa a Claude`,
        claude.llamadas.length === 1 && (vuelta.message.content[0] as { text: string }).text === "claude",
      );

      reiniciarRespaldo();
      const caido = new ConRespaldo(falso("anthropic", () => new ProviderError("529 overloaded", "overloaded")).provider, gemini.provider);
      let error = "";
      try {
        await caido.stream({ messages: [] });
      } catch (e) {
        error = String(e);
      }
      check("otro error no se pasa a Gemini (no es de saldo)", error.includes("overloaded"), error);

      check("reconoce el saldo de Anthropic", esSinSaldo(new Error("Your credit balance is too low")));
      check("y no confunde un 429", !esSinSaldo(new Error("429 rate limit")));
    }
  } finally {
    globalThis.fetch = original;
    reiniciarRespaldo();
    await rm(dir, { recursive: true, force: true });
  }

  console.log(`\n${pass} pasaron, ${fail} fallaron`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("demo falló:", err);
  process.exit(1);
});
