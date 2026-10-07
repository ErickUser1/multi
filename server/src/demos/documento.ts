import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { iniciarDocumentoTool } from "../agent/tools/documento.js";
import { ToolError, type ToolContext, type ToolEvent } from "../agent/tools/base.js";
import { localRunner } from "../engine/runner.js";
import {
  esDocumento,
  leerDocumento,
  imagenDelDocumento,
  archivosDelEsqueleto,
  nombreSeguro,
} from "../engine/documento.js";
import { accionDeTool } from "../engine/actividad.js";

/**
 * Demo: la sala se vuelve documento y se lee bien.
 * Uso: npm run demo:documento
 *
 * 1. iniciar_documento siembra el esqueleto: índice + una sección pendiente por
 *    parte, y la sala pasa a ser documento.
 * 2. Leer el documento: las pendientes traen su intención; las escritas, su
 *    markdown sin la marca.
 * 3. Lo que no se puede: segundo esqueleto, sala con proyecto de software,
 *    nombres que escapan de la carpeta, imágenes SVG.
 *
 * No necesita red ni Docker.
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

async function contexto(): Promise<{ ctx: ToolContext; dir: string; eventos: ToolEvent[] }> {
  const dir = await mkdtemp(join(tmpdir(), "multi-doc-"));
  const eventos: ToolEvent[] = [];
  return {
    dir,
    eventos,
    ctx: { workspaceDir: dir, runner: localRunner(dir), agentId: "agente-1", emit: (e) => eventos.push(e) },
  };
}

async function falla(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof ToolError ? e.message : `otro error: ${String(e)}`;
  }
}

async function main(): Promise<void> {
  console.log("\n1. El esqueleto");
  const { ctx, dir, eventos } = await contexto();
  check("una sala vacía no es documento", !esDocumento(dir));

  const salida = await iniciarDocumentoTool.run(
    {
      titulo: "Propuesta de Multi",
      secciones: [
        { titulo: "Resumen ejecutivo", intencion: "Qué es Multi y qué se busca" },
        { titulo: "El problema", intencion: "Por qué coordinar equipos con IA es difícil" },
        { titulo: "El problema", intencion: "Un título repetido" },
      ],
    },
    ctx,
  );
  check("la sala ya es documento", esDocumento(dir));
  check("la respuesta lista las secciones a escribir", salida.includes("documento/secciones/"), salida);
  check(
    "avisa cada archivo creado (índice + 3 secciones)",
    eventos.filter((e) => e.type === "file:changed").length === 4,
    JSON.stringify(eventos),
  );
  check(
    "la actividad lo dice como documento, no como 'otra'",
    accionDeTool("iniciar_documento", { titulo: "x" }).tipo === "documento",
  );

  console.log("\n2. Leer el documento");
  let doc = await leerDocumento(dir);
  check("trae el título", doc?.titulo === "Propuesta de Multi", JSON.stringify(doc?.titulo));
  check("trae las tres secciones en orden", doc?.secciones.length === 3);
  const ids = doc?.secciones.map((s) => s.id) ?? [];
  check("dos títulos iguales no chocan de id", new Set(ids).size === 3, JSON.stringify(ids));
  check(
    "las secciones nacen pendientes con su intención",
    doc?.secciones[0].pendiente === "Qué es Multi y qué se busca",
    JSON.stringify(doc?.secciones[0]),
  );
  check(
    "la pendiente ya trae su encabezado y sin la marca",
    doc?.secciones[0].markdown === "## Resumen ejecutivo",
    JSON.stringify(doc?.secciones[0].markdown),
  );

  // El agente escribe la primera sección: reemplaza el archivo entero.
  const archivo = doc!.secciones[0].archivo;
  await writeFile(
    join(dir, "documento", "secciones", archivo),
    "## Resumen ejecutivo\n\nMulti es una sala donde varias personas construyen con IA.\n",
  );
  doc = await leerDocumento(dir);
  check("una sección escrita deja de estar pendiente", doc?.secciones[0].pendiente === null);
  check("y trae su texto", !!doc?.secciones[0].markdown.includes("varias personas"));
  check("las demás siguen pendientes", doc?.secciones[1].pendiente !== null);

  // El índice lo mantiene el agente: lo raro se salta sin tirar la vista.
  const indice = JSON.parse(await readFile(join(dir, "documento", "documento.json"), "utf8"));
  indice.secciones.push({ id: "fuera", archivo: "../../etc/passwd" }, { archivo: "no-existe.md" }, 42);
  await writeFile(join(dir, "documento", "documento.json"), JSON.stringify(indice));
  doc = await leerDocumento(dir);
  check("un archivo que escapa de la carpeta se ignora", !doc?.secciones.some((s) => s.archivo.includes("..")));
  check(
    "una sección listada sin archivo sale pendiente",
    doc?.secciones.find((s) => s.archivo === "no-existe.md")?.pendiente === "",
  );
  await writeFile(join(dir, "documento", "documento.json"), "{ esto no es json");
  check("un índice roto no revienta: no hay documento que leer", (await leerDocumento(dir)) === null);

  console.log("\n3. Lo que no se puede");
  await writeFile(join(dir, "documento", "documento.json"), JSON.stringify(indice));
  const segundo = await falla(() =>
    iniciarDocumentoTool.run({ titulo: "Otro", secciones: [{ titulo: "A", intencion: "a" }] }, ctx),
  );
  check("no se empieza un segundo documento encima del primero", !!segundo?.includes("ya es un documento"), String(segundo));

  const app = await contexto();
  await writeFile(
    join(app.dir, "package.json"),
    JSON.stringify({ name: "app", scripts: { dev: "vite --host" } }),
  );
  const enApp = await falla(() =>
    iniciarDocumentoTool.run({ titulo: "Doc", secciones: [{ titulo: "A", intencion: "a" }] }, app.ctx),
  );
  check("una sala de software no se vuelve documento", !!enApp?.includes("proyecto de software"), String(enApp));
  check("y no se le crea nada", !existsSync(join(app.dir, "documento")));

  const vacio = await contexto();
  const sinSecciones = await falla(() => iniciarDocumentoTool.run({ titulo: "Doc", secciones: [] }, vacio.ctx));
  check("sin secciones no hay esqueleto", sinSecciones !== null && !esDocumento(vacio.dir), String(sinSecciones));

  check("los nombres planos pasan", nombreSeguro("01-intro.md") && nombreSeguro("grafica_1.png"));
  check(
    "lo que sale de la carpeta no",
    !nombreSeguro("../x.md") && !nombreSeguro("a/b.md") && !nombreSeguro("/etc/passwd") && !nombreSeguro(".."),
  );

  await mkdir(join(dir, "documento", "imagenes"), { recursive: true });
  await writeFile(join(dir, "documento", "imagenes", "logo.png"), "png");
  await writeFile(join(dir, "documento", "imagenes", "dibujo.svg"), "<svg onload='alert(1)'/>");
  check("una imagen png se sirve", imagenDelDocumento(dir, "logo.png")?.tipo === "image/png");
  check("una svg no (puede traer código)", imagenDelDocumento(dir, "dibujo.svg") === null);
  check("una que no existe no", imagenDelDocumento(dir, "nada.png") === null);

  const marcaRara = archivosDelEsqueleto("T", [{ titulo: "X", intencion: "cierra --> el comentario" }]);
  check(
    "una intención con '-->' no rompe la marca de pendiente",
    !marcaRara[1].contenido.includes("cierra -->"),
    marcaRara[1].contenido,
  );

  await Promise.all([dir, app.dir, vacio.dir].map((d) => rm(d, { recursive: true, force: true })));
  console.log(`\n${pass} pasaron, ${fail} fallaron`);
  if (fail > 0) process.exit(1);
}

void main();
