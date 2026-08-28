import { createServer } from "node:http";
import { mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { AnthropicProvider } from "../agent/providers/anthropic.js";
import { OpenAICompatProvider } from "../agent/providers/openai-compat.js";
import { proveedorVe } from "../agent/providers/profiles.js";
import type { Message } from "../agent/providers/types.js";
import {
  guardarAdjunto,
  leerAdjunto,
  adjuntosDir,
  AdjuntoInvalido,
  type Adjunto,
} from "../engine/adjuntos.js";
import { usarAdjuntoTool } from "../agent/tools/adjuntos.js";
import type { ToolContext, ToolEvent } from "../agent/tools/base.js";

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
 * El PDF más chico que es un PDF de verdad: empieza con "%PDF-", que es lo que
 * mira la validación de firma. Solo para esta demo, como el PNG de arriba.
 */
const PDF_MINIMO = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
).toString("base64");

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

  // ── 5. Guardar y leer del disco ───────────────────────────────────────────
  console.log("\nGuardado (fuera del proyecto):");
  const raiz = join(tmpdir(), `multi-adjuntos-${randomUUID()}`);
  const ws = join(raiz, "sala-demo");
  await mkdir(ws, { recursive: true });
  let guardado: Adjunto | null = null;
  {
    guardado = await guardarAdjunto(ws, {
      nombre: "logo.png",
      mediaType: "image/png",
      data: PNG_1X1,
    });

    check("guarda y devuelve un id", !!guardado.id);
    check("conserva el nombre para mostrarlo", guardado.nombre === "logo.png");
    check(
      "el archivo cae FUERA del workspace",
      existsSync(join(adjuntosDir(ws), guardado.id)) && !existsSync(join(ws, guardado.id)),
    );
    check(
      "el nombre en disco no viene de quien lo subió",
      guardado.id !== "logo.png" && guardado.id.endsWith(".png"),
      `→ ${guardado.id}`,
    );

    const leido = await leerAdjunto(ws, guardado.id);
    check("se puede leer de vuelta en base64", leido?.data === PNG_1X1);

    check("un id que no existe devuelve null", (await leerAdjunto(ws, "noexiste.png")) === null);
    check(
      "no se puede salir del directorio con ..",
      (await leerAdjunto(ws, "../../../etc/passwd")) === null,
    );
  }

  console.log("\nLo que no se acepta:");
  {
    const rechaza = async (que: string, entrada: Parameters<typeof guardarAdjunto>[1]) => {
      try {
        await guardarAdjunto(ws, entrada);
        check(que, false, "→ lo aceptó");
      } catch (err) {
        check(que, err instanceof AdjuntoInvalido, `→ ${String(err)}`);
      }
    };

    // El caso que motivó validar el contenido: el mediaType lo declara el
    // navegador y se puede cambiar. Sin mirar los primeros bytes, un ejecutable
    // renombrado a .pdf se guarda, se le sirve al resto de la sala, y alguien lo
    // abre confiando en la extensión.
    await rechaza("algo que dice ser PDF pero no lo es", {
      nombre: "x.pdf",
      mediaType: "application/pdf",
      data: PNG_1X1,
    });
    await rechaza("una imagen que no es lo que dice", {
      nombre: "x.png",
      mediaType: "image/png",
      data: PDF_MINIMO,
    });
    await rechaza("un SVG (puede traer scripts)", {
      nombre: "x.svg",
      mediaType: "image/svg+xml",
      data: PNG_1X1,
    });
    await rechaza("un archivo sin datos", {
      nombre: "x.png",
      mediaType: "image/png",
      data: "",
    });
    await rechaza("una imagen de más de 2MB", {
      nombre: "grande.png",
      mediaType: "image/png",
      // Con la firma correcta al principio: lo que tiene que rechazar es el
      // tamaño, no el contenido.
      data: Buffer.concat([
        Buffer.from(PNG_1X1, "base64"),
        Buffer.alloc(3 * 1024 * 1024),
      ]).toString("base64"),
    });
  }

  console.log("\nY los PDF, que el modelo lee solos:");
  {
    const pdf = await guardarAdjunto(ws, {
      nombre: "apuntes.pdf",
      mediaType: "application/pdf",
      data: PDF_MINIMO,
    });
    check("se acepta un PDF", pdf.mediaType === "application/pdf", pdf.mediaType);
    check("con su extensión en el id", pdf.id.endsWith(".pdf"), pdf.id);
    check("y se puede leer de vuelta", (await leerAdjunto(ws, pdf.id))?.data === PDF_MINIMO);

    // Un PDF cabe hasta 32MB, mucho más que una imagen: no se puede encoger
    // antes de mandarlo, y la API de Anthropic acepta ese tope.
    const grande = Buffer.concat([
      Buffer.from(PDF_MINIMO, "base64"),
      Buffer.alloc(5 * 1024 * 1024),
    ]).toString("base64");
    const cabe = await guardarAdjunto(ws, {
      nombre: "tesis.pdf",
      mediaType: "application/pdf",
      data: grande,
    }).then(
      () => true,
      () => false,
    );
    check("uno de 5MB cabe (una imagen de ese tamaño no)", cabe);
  }

  console.log("\nCómo llega un PDF al modelo:");
  {
    // La diferencia que importa: Anthropic quiere `document`, no `image`. Con un
    // bloque de imagen el PDF da 400 y el turno muere por algo evitable.
    const espia = await servidorEspia("anthropic");
    const provider = new AnthropicProvider("sk-ant-falsa");
    const original = globalThis.fetch;
    globalThis.fetch = ((url: any, init: any) => original(espia.url, init)) as typeof fetch;

    await provider.stream({
      messages: [
        {
          role: "user",
          content: [
            { type: "documento", mediaType: "application/pdf", data: PDF_MINIMO },
            { type: "text", text: "resume esto" },
          ],
        },
      ],
      maxTokens: 64,
    });
    globalThis.fetch = original;

    const bloques = espia.ultimoCuerpo()?.messages?.[0]?.content ?? [];
    const doc = bloques.find((b: any) => b.type === "document");
    check("manda un bloque type:document, no image", !!doc, JSON.stringify(bloques[0]?.type));
    check("con el tipo declarado", doc?.source?.media_type === "application/pdf");
    check("en base64", doc?.source?.type === "base64");
    check("y el texto va después", bloques[1]?.type === "text");
    espia.cerrar();
  }

  // ── 6. La tool que la mete al proyecto ────────────────────────────────────
  console.log("\nusar_adjunto (la puerta al proyecto):");
  {
    const ctx = { workspaceDir: ws } as ToolContext;
    let emitido: ToolEvent | null = null;
    const ctxConEmit = {
      ...ctx,
      emit: (e: ToolEvent) => {
        emitido = e;
      },
    };

    const res = await usarAdjuntoTool.run(
      { adjunto: guardado!.id, destino: "public/logo.png" },
      ctxConEmit,
    );
    check("copia el archivo al workspace", existsSync(join(ws, "public", "logo.png")));
    check("crea las carpetas que falten", res.includes("public/logo.png"));
    check(
      "avisa que el archivo cambió, para que el preview lo recoja",
      (emitido as ToolEvent | null)?.type === "file:changed",
    );

    const escapa = async (destino: string) => {
      try {
        await usarAdjuntoTool.run({ adjunto: guardado!.id, destino }, ctx);
        return false;
      } catch {
        return true;
      }
    };
    check("no deja escribir fuera del workspace con ..", await escapa("../../fuera.png"));
    check("no deja rutas absolutas", await escapa("/tmp/fuera.png"));

    // El agente normalmente escribe el nombre que ve en el chat, no el id.
    await usarAdjuntoTool.run({ adjunto: "logo.png", destino: "assets/logo.png" }, ctx);
    check("también lo encuentra por su nombre", existsSync(join(ws, "assets", "logo.png")));

    let mensaje = "";
    try {
      await usarAdjuntoTool.run({ adjunto: "noexiste.png", destino: "public/x.png" }, ctx);
    } catch (err) {
      mensaje = String(err);
    }
    check(
      "un nombre que no existe NO cae en la única imagen que hay",
      mensaje.length > 0 && !existsSync(join(ws, "public", "x.png")),
      "→ copió la que no era",
    );
    check("y el error dice cuáles hay", mensaje.includes("logo.png"));
  }

  await rm(raiz, { recursive: true, force: true });

  console.log(`\n${pass} bien, ${fail} mal\n`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
