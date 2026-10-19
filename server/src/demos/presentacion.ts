import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDict, PDFDocument, PDFName } from "pdf-lib";
import { localRunner } from "../engine/runner.js";
import { exportarPresentacion } from "../engine/captura.js";

/**
 * Demo: Multti exporta la presentación de la sala a PDF y PowerPoint.
 * Uso: npm run demo:presentacion
 *
 * Lo que cubre: antes cada agente armaba sus archivos a mano (pptxgenjs, jspdf)
 * y su propio botón; una persona no lo encontró dos veces. Ahora salen de lo que
 * el navegador dibujó (docker/qa/exportar.mjs). Se prueba que salgan todas las
 * diapositivas, que el texto del PowerPoint sea editable y esté en su lugar, que
 * las flechas de la página no se cuelen, que las notas lleguen, y que una página
 * que no cumple el contrato reciba un error que se entienda.
 *
 * Necesita Chromium (el de Playwright) y `unzip`, como en el CI.
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

const PRESENTACION = await readFile(
  fileURLToPath(new URL("./fixtures/presentacion.html", import.meta.url)),
  "utf8",
);

const PAGINAS: Record<string, string> = {
  "/": PRESENTACION,
  // Sin data-diapositiva: no es presentación para Multti.
  "/sin-marcas/": "<!doctype html><title>Nada</title><h1>Una página cualquiera</h1>",
  // Marca tres diapositivas pero solo enseña la primera, haga lo que haga el #.
  "/sin-hash/": `<!doctype html><title>Terca</title><style>section{width:1920px;height:1080px}</style>
    <section data-diapositiva>Uno</section><section data-diapositiva style="display:none">Dos</section>
    <section data-diapositiva style="display:none">Tres</section>`,
};

function servidor(): Promise<{ server: Server; base: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const html = PAGINAS[(req.url ?? "/").split("#")[0]];
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

/** Un archivo de adentro del .pptx, como texto. */
function deAdentro(zip: string, ruta: string): string {
  try {
    return execFileSync("unzip", ["-p", zip, ruta], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return "";
  }
}

async function main() {
  console.log("=== Multti exporta la presentación ===\n");
  const { server, base } = await servidor();
  const dir = await mkdtemp(join(tmpdir(), "multi-presentacion-"));
  const runner = localRunner(dir);

  try {
    console.log("1. PDF");
    {
      const r = await exportarPresentacion(runner, base, "pdf");
      check("sale bien", r.ok, r.ok ? "" : r.error);
      if (r.ok) {
        const pdf = await PDFDocument.load(Buffer.from(r.archivo, "base64"));
        check("una página por diapositiva (5)", pdf.getPageCount() === 5, String(pdf.getPageCount()));
        const { width, height } = pdf.getPage(0).getSize();
        check("cada página es de 16:9", Math.abs(width / height - 16 / 9) < 0.01, `${width}×${height}`);
        check("el título de la página nombra el archivo", r.titulo === "La Revolución Mexicana", r.titulo);
        // Texto de verdad y no una foto: el PDF trae fuentes.
        const fuentes = pdf.context
          .enumerateIndirectObjects()
          .filter(([, o]) => o instanceof PDFDict && o.get(PDFName.of("Type")) === PDFName.of("Font")).length;
        check("el texto es texto (lleva fuentes)", fuentes > 0, String(fuentes));
      }
    }

    console.log("\n2. PowerPoint");
    {
      const r = await exportarPresentacion(runner, base, "pptx");
      check("sale bien", r.ok, r.ok ? "" : r.error);
      if (r.ok) {
        const zip = join(dir, "p.pptx");
        await writeFile(zip, Buffer.from(r.archivo, "base64"));
        const lista = execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" });
        const hojas = (lista.match(/^ppt\/slides\/slide\d+\.xml$/gm) ?? []).length;
        check("5 diapositivas", hojas === 5, String(hojas));

        const uno = deAdentro(zip, "ppt/slides/slide1.xml");
        const textos = [...uno.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join(" | ");
        check("el título es texto editable", textos.includes("¿Por qué estalló la Revolución en 1910?"), textos);
        check("cada diapositiva lleva su foto de fondo", /<p:bg>[\s\S]*r:embed/.test(uno));
        check("con letra grande (títulos de 112 px → 56 pt)", /sz="5600"/.test(uno));

        const todas = [1, 2, 3, 4, 5].map((n) => deAdentro(zip, `ppt/slides/slide${n}.xml`)).join("");
        check("las flechas de la página no se cuelan", !todas.includes("◀") && !todas.includes("▶"));
        check("el texto del SVG se queda en el dibujo", !todas.includes("hacienda y pueblo"));

        const conAcento = deAdentro(zip, "ppt/slides/slide2.xml");
        check("un span con otro color es un tramo con su color", /srgbClr val="B0301E"/i.test(conAcento));
        check("las notas no salen en la diapositiva", !conAcento.includes("mil familias antes de pasar"));
        const notas = deAdentro(zip, "ppt/notesSlides/notesSlide2.xml");
        check("pero sí en las notas del presentador", notas.includes("mil familias antes de pasar"));
      }
    }

    console.log("\n3. Lo que no es presentación se dice claro");
    {
      const sin = await exportarPresentacion(runner, `${base}/sin-marcas`, "pdf");
      check("sin data-diapositiva", !sin.ok && sin.error.includes("data-diapositiva"), sin.ok ? "salió" : sin.error);
      const terca = await exportarPresentacion(runner, `${base}/sin-hash`, "pptx");
      check("si no responde a #n, dice cuál no apareció", !terca.ok && terca.error.includes("#2"), terca.ok ? "salió" : terca.error);
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
