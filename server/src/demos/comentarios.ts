import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { SqliteStorage } from "../storage/sqlite.js";
import { operacionesDeDocumento } from "../agent/tools/documento.js";
import { comentarTool } from "../agent/tools/comentarios.js";
import { ToolError, type ToolContext } from "../agent/tools/base.js";
import { localRunner } from "../engine/runner.js";
import { documentosVivos, estado, FRAGMENTO, idDeElemento } from "../engine/doc-vivo.js";
import { anclaDeCita, textoDeAncla, anclaValida, seccionDeBloque, type Ancla } from "../engine/comentarios.js";

/**
 * Demo: los comentarios del documento.
 * Uso: npm run demo:comentarios
 *
 * 1. Guardar, leer y resolver hilos.
 * 2. El ancla sigue a su frase: escriben antes, después y en medio, y sigue
 *    cubriendo lo mismo; si se borra, queda vacía.
 * 3. La tool comentar: responder, abrir uno nuevo, y lo que no se puede.
 *
 * Lo que decide si un comentario despierta al agente (solo, multi, @) es la
 * misma función que el chat, cubierta por demo:modo-de-sala; y que la respuesta
 * caiga en el hilo, por la prueba de navegador.
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

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "multi-com-"));

  console.log("\n1. Hilos");
  const db = new SqliteStorage(join(dir, "multi.db"));
  await db.init();
  await db.createRoom({ id: "sala-c", workspaceDir: dir, createdAt: Date.now(), lastActiveAt: Date.now() } as never);
  const base = { roomId: "sala-c", ancla: null, cita: null, color: "#fff", rol: "human" as const, usuarioId: null, resuelto: false };
  await db.addComentario({ ...base, id: "h1", hiloId: "h1", ancla: '{"bloque":"x"}', cita: "una frase", autor: "Ana", texto: "¿Esto es así?", creado: 1 });
  await db.addComentario({ ...base, id: "r1", hiloId: "h1", autor: "agente-1", rol: "agent", texto: "Sí, lo revisé.", creado: 2 });
  let todos = await db.getComentarios("sala-c");
  check("se guardan en orden, raíz y respuesta", todos.map((c) => c.id).join() === "h1,r1");
  check("la raíz guarda su ancla y su cita", todos[0].ancla === '{"bloque":"x"}' && todos[0].cita === "una frase");
  await db.resolverHilo("sala-c", "h1", true);
  todos = await db.getComentarios("sala-c");
  check("resolver marca el hilo", todos[0].resuelto && !todos[1].resuelto);
  await db.resolverHilo("sala-c", "h1", false);
  check("y se puede reabrir", !(await db.getComentarios("sala-c"))[0].resuelto);

  console.log("\n2. El ancla sigue a su frase");
  const ops = operacionesDeDocumento("sala-c", dir, "agente-1");
  await ops.iniciar("Plan", [{ titulo: "Presupuesto", intencion: "cuánto cuesta" }]);
  const leido = await ops.leer();
  const sec = leido.match(/«Presupuesto» seccion=(\S+) huella_seccion=(\S+)/)!;
  await ops.escribirSeccion(sec[1], sec[2], "## Presupuesto\n\nEl servidor cuesta cien pesos al mes.");
  const doc = documentosVivos.obtener("sala-c")!;
  const { bloques, ids } = estado(doc);
  const bloque = ids[bloques.findIndex((b) => JSON.stringify(b).includes("cien pesos"))];
  const ancla = anclaDeCita(doc, bloque, "cien pesos")!;
  check("una cita del bloque da un ancla", !!ancla && textoDeAncla(doc, ancla) === "cien pesos", JSON.stringify(ancla));
  check("la sección del bloque se sabe", seccionDeBloque(doc, bloque) === "Presupuesto");

  const elemento = doc.ydoc
    .getXmlFragment(FRAGMENTO)
    .toArray()
    .find((e) => e instanceof Y.XmlElement && idDeElemento(e) === bloque) as Y.XmlElement;
  const texto = elemento.get(0) as Y.XmlText;
  doc.ydoc.transact(() => texto.insert(0, "Ojo: "), { autor: "Beto" });
  check("si escriben antes, sigue cubriendo lo mismo", textoDeAncla(doc, ancla) === "cien pesos", String(textoDeAncla(doc, ancla)));
  doc.ydoc.transact(() => texto.insert(texto.length, " Más IVA."), { autor: "Beto" });
  check("si escriben después, también", textoDeAncla(doc, ancla) === "cien pesos");
  const i = texto.toString().indexOf("pesos");
  doc.ydoc.transact(() => texto.insert(i, "mil "), { autor: "Beto" });
  check("si escriben en medio, el ancla crece con su frase", textoDeAncla(doc, ancla) === "cien mil pesos", String(textoDeAncla(doc, ancla)));
  const j = texto.toString().indexOf("cien");
  doc.ydoc.transact(() => texto.delete(j, "cien mil pesos".length), { autor: "Beto" });
  check("si la borran, el ancla queda vacía", !textoDeAncla(doc, ancla), String(textoDeAncla(doc, ancla)));
  check("una cita que no está no da ancla", anclaDeCita(doc, bloque, "no existe") === null);

  check("un ancla de un navegador con la forma correcta pasa", !!anclaValida({ bloque: "a.1", inicio: "AAA", fin: "BBB" }));
  check(
    "lo que no, no",
    anclaValida({ bloque: "a.1" }) === null &&
      anclaValida("hola") === null &&
      anclaValida({ bloque: "x".repeat(50), objeto: "g" }) === null &&
      anclaValida({ bloque: "a", inicio: "x".repeat(500), fin: "y" }) === null,
  );

  console.log("\n3. La tool comentar");
  const hechos: string[] = [];
  const ctx: ToolContext = {
    workspaceDir: dir,
    runner: localRunner(dir),
    comentarios: {
      responder: async (hilo, t) => {
        hechos.push(`responder ${hilo}: ${t}`);
        return "ok";
      },
      nuevo: async (b, c, t) => {
        const a: Ancla | null = anclaDeCita(doc, b, c);
        if (!a) throw new ToolError("esa cita no está");
        hechos.push(`nuevo ${b} «${c}»: ${t}`);
        return "ok";
      },
    },
  };
  const falla = async (input: Record<string, unknown>, c: ToolContext = ctx) => {
    try {
      await comentarTool.run(input, c);
      return null;
    } catch (e) {
      return e instanceof ToolError ? e.message : String(e);
    }
  };
  await comentarTool.run({ hilo: "h1", texto: "  Listo.  " }, ctx);
  check("responder en un hilo", hechos.at(-1) === "responder h1: Listo.");
  await comentarTool.run({ bloque, cita: "IVA", texto: "¿Con o sin IVA?" }, ctx);
  check("abrir uno nuevo sobre una cita", hechos.at(-1) === `nuevo ${bloque} «IVA»: ¿Con o sin IVA?`);
  check("una cita que no está se rechaza", !!(await falla({ bloque, cita: "nada que ver", texto: "x" }))?.includes("no está"));
  check("sin hilo ni bloque se explica", !!(await falla({ texto: "x" }))?.includes("hilo"));
  check("vacío no", !!(await falla({ hilo: "h1", texto: "   " }))?.includes("vacío"));
  check("sin la capacidad lo dice", !!(await falla({ hilo: "h1", texto: "x" }, { ...ctx, comentarios: undefined }))?.includes("no hay documento"));

  await documentosVivos.cerrar("sala-c");
  await db.close();
  await rm(dir, { recursive: true, force: true });
  console.log(`\n${pass} pasaron, ${fail} fallaron`);
  if (fail > 0) process.exit(1);
}

void main();
