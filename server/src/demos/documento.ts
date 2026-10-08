import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { documentoTools, operacionesDeDocumento } from "../agent/tools/documento.js";
import { writeTool } from "../agent/tools/fs.js";
import { ToolError, type Tool, type ToolContext, type ToolEvent } from "../agent/tools/base.js";
import { localRunner } from "../engine/runner.js";
import { esDocumento, imagenDelDocumento, nombreSeguro } from "../engine/documento.js";
import { documentosVivos, estado, exportarMarkdown, FRAGMENTO } from "../engine/doc-vivo.js";
import { markdownABloques, bloquesAMarkdown } from "../engine/doc-markdown.js";
import { accionDeTool } from "../engine/actividad.js";
import { commitAll, revertTo } from "../engine/git.js";
import { execFileSync } from "node:child_process";

async function initRepo(dir: string): Promise<void> {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "demo@multi"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "demo"], { cwd: dir });
}

/**
 * Demo: el documento vivo (Yjs).
 * Uso: npm run demo:documento
 *
 * 1. Markdown ⇄ bloques: lo que entra sale igual, y una segunda vuelta no cambia nada.
 * 2. Las tools del agente: esqueleto, leer con ids y huellas, escribir secciones,
 *    reemplazar/insertar/borrar bloques, gráficas.
 * 3. La escritura condicional por bloque: si una persona cambió el bloque, el
 *    agente recibe el rechazo con su nombre; si cambió otro bloque, pasa.
 * 4. Disco: se guarda, se recarga igual, migra el formato viejo, volver atrás
 *    sube la generación.
 * 5. Lo que no se puede.
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

const tool = (n: string): Tool => documentoTools.find((t) => t.spec.name === n)!;

async function sala(id: string): Promise<{ ctx: ToolContext; dir: string; eventos: ToolEvent[] }> {
  const dir = await mkdtemp(join(tmpdir(), "multi-doc-"));
  const eventos: ToolEvent[] = [];
  return {
    dir,
    eventos,
    ctx: {
      workspaceDir: dir,
      runner: localRunner(dir),
      agentId: "agente-1",
      emit: (e) => eventos.push(e),
      documento: operacionesDeDocumento(id, dir, "agente-1"),
    },
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

/** Saca de la salida de leer_documento la línea del índice de una sección. */
function seccion(leido: string, titulo: string): { id: string; huella: string } {
  const m = leido.match(new RegExp(`«${titulo}» seccion=(\\S+) huella_seccion=(\\S+)`));
  if (!m) throw new Error(`no encontré la sección ${titulo} en:\n${leido}`);
  return { id: m[1], huella: m[2] };
}

/** El ⟦id·huella⟧ del bloque cuyo markdown empieza con `inicio`. */
function bloque(leido: string, inicio: string): { id: string; huella: string } {
  const m = leido.match(new RegExp(`⟦([^·]+)·([0-9a-f]+)⟧\\n${inicio.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  if (!m) throw new Error(`no encontré el bloque "${inicio}" en:\n${leido}`);
  return { id: m[1], huella: m[2] };
}

const FIXTURE = `# Propuesta

## Resumen

Multi es una **sala** donde *varias* personas ~~no~~ construyen con IA. [Sitio](https://example.com) y \`código\`.

<!-- pendiente: Los números del piloto -->

- uno
- dos con **negrita**
  - anidado

1. primero
2. segundo

> una cita

| Condición | Alumnos | Errores |
| --- | --- | --- |
| Solo | 13 | 6 |
| Multi \\| x | 15 | 3 |

\`\`\`grafica
{"tipo":"barras","etiquetas":["A"],"series":[{"datos":[1]}]}
\`\`\`

\`\`\`diagrama
<svg viewBox="0 0 10 10"><text data-id="t1">Hola</text></svg>
\`\`\`

\`\`\`js
const x = 1
\`\`\`

![logo](imagenes/punto.png)

---`;

async function main(): Promise<void> {
  console.log("\n1. Markdown ⇄ bloques");
  const a = markdownABloques(FIXTURE);
  const md2 = bloquesAMarkdown(a.bloques, a.objetos);
  check("lo que entra sale igual", md2 === FIXTURE, `\n---\n${md2}\n---`);
  const b = markdownABloques(md2);
  check("una segunda vuelta no cambia nada", bloquesAMarkdown(b.bloques, b.objetos) === md2);
  check("la gráfica y el diagrama son objetos aparte", Object.values(a.objetos).map((o) => o.tipo).sort().join() === "diagrama,grafica");
  check("cada bloque de arriba trae id", a.bloques.every((x) => typeof x.attrs?.id === "string"));
  const raro = markdownABloques("<div onclick=x>html suelto</div>\n\nTexto con ![img](a.png) en medio.");
  check(
    "lo que no se reconoce queda como texto, no se tira",
    bloquesAMarkdown(raro.bloques, raro.objetos).includes("html suelto") &&
      bloquesAMarkdown(raro.bloques, raro.objetos).includes("img"),
  );
  check(
    "las dos copias del esquema (server y web) son idénticas",
    readFileSync(new URL("../engine/doc-esquema.ts", import.meta.url), "utf8") ===
      readFileSync(new URL("../../../web/src/documento/esquema.ts", import.meta.url), "utf8"),
  );

  console.log("\n2. Las tools del agente");
  const { ctx, dir, eventos } = await sala("sala-a");
  await initRepo(dir);
  check("una sala vacía no es documento", !esDocumento(dir));
  const esqueleto = await tool("iniciar_documento").run(
    {
      titulo: "Propuesta de Multi",
      secciones: [
        { titulo: "Resumen", intencion: "Qué es Multi" },
        { titulo: "Presupuesto", intencion: "Cuánto cuesta --> y por qué" },
        { titulo: "Equipo", intencion: "Quién lo hace" },
      ],
    },
    ctx,
  );
  check("la sala ya es documento", esDocumento(dir));
  check("en disco quedan el estado y la exportación", existsSync(join(dir, "documento/doc.yjs")) && existsSync(join(dir, "documento/documento.md")));
  check("avisa a la sala", eventos.some((e) => e.type === "file:changed"));
  check("devuelve el índice con las tres pendientes", (esqueleto.match(/\(PENDIENTE\)/g) ?? []).length === 3, esqueleto);
  check("una intención con '-->' no rompe la marca", !esqueleto.includes("cuesta -->"));
  check("la actividad lo dice como documento", accionDeTool("escribir_seccion", {}).tipo === "escribirDocumento");

  let leido = await tool("leer_documento").run({}, ctx);
  const resumen = seccion(leido, "Resumen");
  await tool("escribir_seccion").run(
    { seccion: resumen.id, huella: resumen.huella, markdown: "## Resumen\n\nMulti es una sala.\n\nSegundo párrafo." },
    ctx,
  );
  leido = await tool("leer_documento").run({}, ctx);
  check("la sección escrita deja de estar pendiente", !/«Resumen».*PENDIENTE/.test(leido));
  check("conserva el id de su título", seccion(leido, "Resumen").id === resumen.id);
  const viejo = await falla(() =>
    tool("escribir_seccion").run({ seccion: resumen.id, huella: resumen.huella, markdown: "## Resumen\n\nOtra cosa." }, ctx),
  );
  check("con la huella vieja se rechaza", !!viejo?.includes("cambió desde que lo leíste"), String(viejo));

  // Una persona edita el primer párrafo directo en el Y.Doc, como lo haría el editor.
  const doc = documentosVivos.obtener("sala-a")!;
  const p1 = bloque(leido, "Multi es una sala.");
  const p2 = bloque(leido, "Segundo párrafo.");
  const frag = doc.ydoc.getXmlFragment(FRAGMENTO);
  const elemento = frag.toArray().find((e) => e instanceof Y.XmlElement && e.getAttribute("id") === p1.id) as Y.XmlElement;
  doc.ydoc.transact(() => (elemento.get(0) as Y.XmlText).insert(0, "Hoy "), { autor: "Erick" });
  const pisar = await falla(() => tool("reemplazar_bloque").run({ id: p1.id, huella: p1.huella, markdown: "Reescrito." }, ctx));
  check("el agente no pisa lo que una persona acaba de cambiar", !!pisar?.includes("lo tocó Erick"), String(pisar));
  const otro = await falla(() => tool("reemplazar_bloque").run({ id: p2.id, huella: p2.huella, markdown: "Segundo, mejorado." }, ctx));
  check("pero sí cambia otro bloque de la misma sección", otro === null, String(otro));
  leido = await tool("leer_documento").run({}, ctx);
  check("y lo de la persona sigue ahí", leido.includes("Hoy Multi es una sala.") && leido.includes("Segundo, mejorado."));

  const presupuesto = seccion(leido, "Presupuesto");
  await tool("escribir_seccion").run(
    {
      seccion: presupuesto.id,
      huella: presupuesto.huella,
      markdown:
        '## Presupuesto\n\n| Concepto | Monto |\n| --- | --- |\n| Servidor | 100 |\n\n```grafica\n{"tipo":"barras","etiquetas":["Servidor"],"series":[{"datos":[100]}]}\n```',
    },
    ctx,
  );
  leido = await tool("leer_documento").run({}, ctx);
  const g = bloque(leido, "```grafica");
  await tool("cambiar_grafica").run(
    { id: g.id, huella: g.huella, datos: { tipo: "pastel", etiquetas: ["Servidor"], series: [{ datos: [250] }] } },
    ctx,
  );
  check("cambiar_grafica cambia solo los datos", exportarMarkdown(doc).includes('"datos":[250]'));
  leido = await tool("leer_documento").run({}, ctx);
  const equipo = seccion(leido, "Equipo");
  await tool("insertar_bloques").run({ despues_de: equipo.id, markdown: "Ana y Beto." }, ctx);
  leido = await tool("leer_documento").run({}, ctx);
  const ana = bloque(leido, "Ana y Beto.");
  await tool("borrar_bloque").run({ id: ana.id, huella: ana.huella }, ctx);
  check("insertar y borrar", !exportarMarkdown(doc).includes("Ana y Beto."));
  await tool("mover_seccion").run({ seccion: equipo.id, antes_de: presupuesto.id }, ctx);
  const md = exportarMarkdown(doc);
  check("mover una sección", md.indexOf("## Equipo") < md.indexOf("## Presupuesto"));

  const escribirArchivo = await falla(() => writeTool.run({ path: "documento/documento.md", content: "x" }, ctx));
  check("write_file sobre documento/ se rechaza", !!escribirArchivo?.includes("leer_documento"), String(escribirArchivo));
  const imagen = await falla(() => writeTool.run({ path: "documento/imagenes/a.png", content: "png" }, ctx));
  check("pero las imágenes sí son archivos", imagen === null, String(imagen));
  const segundo = await falla(() => tool("iniciar_documento").run({ titulo: "Otro", secciones: [{ titulo: "A", intencion: "a" }] }, ctx));
  check("no se empieza un segundo documento", !!segundo?.includes("ya es un documento"), String(segundo));

  console.log("\n3. Disco e historial");
  await documentosVivos.flush("sala-a");
  const antes = exportarMarkdown(doc);
  const primero = await commitAll(dir, { message: "primero", author: "agente-1" });
  await documentosVivos.cerrar("sala-a");
  const otraVez = await documentosVivos.abrir("sala-a", dir);
  check("al recargar de disco queda igual", exportarMarkdown(otraVez!) === antes);
  check("la exportación en disco es el mismo markdown", (await readFile(join(dir, "documento/documento.md"), "utf8")).trim() === antes);

  leido = await tool("leer_documento").run({}, ctx);
  const res = seccion(leido, "Resumen");
  await tool("escribir_seccion").run({ seccion: res.id, huella: res.huella, markdown: "## Resumen\n\nDespués del commit." }, ctx);
  await documentosVivos.flush("sala-a");
  await commitAll(dir, { message: "segundo", author: "agente-1" });
  const gen = otraVez!.generacion;
  await revertTo(dir, primero!, { author: "Erick" });
  const recargado = await documentosVivos.recargar("sala-a", dir);
  check("volver atrás sube la generación", recargado!.generacion === gen + 1);
  check("y el documento regresa", !exportarMarkdown(recargado!).includes("Después del commit."));

  console.log("\n4. Migración del formato anterior");
  const vieja = await mkdtemp(join(tmpdir(), "multi-doc-viejo-"));
  await mkdir(join(vieja, "documento/secciones"), { recursive: true });
  await writeFile(
    join(vieja, "documento/documento.json"),
    JSON.stringify({ titulo: "Viejo", secciones: [{ id: "a", archivo: "01-a.md" }, { id: "b", archivo: "02-b.md" }] }),
  );
  await writeFile(join(vieja, "documento/secciones/01-a.md"), "## Uno\n\nTexto de uno.\n");
  await writeFile(join(vieja, "documento/secciones/02-b.md"), "## Dos\n\n<!-- pendiente: lo que falta -->\n");
  check("el formato viejo cuenta como documento", esDocumento(vieja));
  const migrado = await documentosVivos.abrir("sala-vieja", vieja);
  const mdMigrado = exportarMarkdown(migrado!);
  check("se convierte con su título, su texto y su pendiente", mdMigrado.includes("# Viejo") && mdMigrado.includes("Texto de uno.") && mdMigrado.includes("pendiente: lo que falta"), mdMigrado);
  check("y lo viejo se borra", !existsSync(join(vieja, "documento/documento.json")) && existsSync(join(vieja, "documento/doc.yjs")));

  console.log("\n5. Lo que no se puede");
  const app = await sala("sala-app");
  await writeFile(join(app.dir, "package.json"), JSON.stringify({ name: "app", scripts: { dev: "vite --host" } }));
  const enApp = await falla(() => tool("iniciar_documento").run({ titulo: "Doc", secciones: [{ titulo: "A", intencion: "a" }] }, app.ctx));
  check("una sala de software no se vuelve documento", !!enApp?.includes("proyecto de software"), String(enApp));
  const sinDoc = await falla(() => tool("leer_documento").run({}, app.ctx));
  check("leer sin documento lo dice", !!sinDoc?.includes("todavía no es un documento"), String(sinDoc));
  const sinCapacidad = await falla(() => tool("leer_documento").run({}, { ...app.ctx, documento: undefined }));
  check("sin la capacidad, la tool lo dice", !!sinCapacidad?.includes("no hay documento"), String(sinCapacidad));
  check("los nombres de imagen que salen de la carpeta no", !nombreSeguro("../x.png") && !nombreSeguro("a/b.png"));
  await mkdir(join(dir, "documento/imagenes"), { recursive: true });
  await writeFile(join(dir, "documento/imagenes/dibujo.svg"), "<svg onload='alert(1)'/>");
  check("una imagen SVG no se sirve", imagenDelDocumento(dir, "dibujo.svg") === null);
  const malo = await falla(() => {
    const l = exportarMarkdownConIds();
    const r = bloque(l, "## Resumen");
    return tool("reemplazar_bloque").run({ id: r.id, huella: r.huella, markdown: "" }, ctx);
  });
  check("un reemplazo vacío se rechaza", !!malo?.includes("vacío"), String(malo));

  function exportarMarkdownConIds(): string {
    const d = documentosVivos.obtener("sala-a")!;
    const { bloques, objetos } = estado(d);
    return bloquesAMarkdown(bloques, objetos, { conIds: true });
  }

  await Promise.all(["sala-a", "sala-vieja"].map((id) => documentosVivos.cerrar(id)));
  await Promise.all([dir, vieja, app.dir].map((d) => rm(d, { recursive: true, force: true })));
  console.log(`\n${pass} pasaron, ${fail} fallaron`);
  if (fail > 0) process.exit(1);
}

void main();
