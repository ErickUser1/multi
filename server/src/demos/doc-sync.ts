import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import {
  documentosVivos,
  responderSync,
  aplicarDeCliente,
  exportarMarkdown,
  FRAGMENTO,
  MAX_UPDATE,
  estado,
  idDeElemento,
  type DocVivo,
} from "../engine/doc-vivo.js";
import { operacionesDeDocumento } from "../agent/tools/documento.js";

/**
 * Demo: la sincronía del documento entre el server y varios navegadores.
 * Uso: npm run demo:doc-sync
 *
 * Cada "navegador" es un Y.Doc conectado al registro del server con las mismas
 * funciones que usa el socket (responderSync, aplicarDeCliente, alCambiar),
 * sin red de por medio.
 *
 * 1. Dos personas escriben a la vez en el MISMO párrafo: todos terminan con el
 *    mismo texto y no se pierde nada de nadie.
 * 2. El agente cambia una sección mientras una persona escribe en otra.
 * 3. Lo que no entra: generación vieja, cambios gigantes o basura.
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

interface Navegador {
  nombre: string;
  ydoc: Y.Doc;
  generacion: number;
  /** Lo que el server le manda y todavía no le llega (la red, en pausa). */
  bandeja: Uint8Array[];
}

const navegadores: Navegador[] = [];

async function conectar(doc: DocVivo, nombre: string): Promise<Navegador> {
  const n: Navegador = { nombre, ydoc: new Y.Doc(), generacion: -1, bandeja: [] };
  const r = responderSync(doc, Y.encodeStateVector(n.ydoc));
  Y.applyUpdate(n.ydoc, r.update, "server");
  n.generacion = r.generacion;
  // Lo que escribe este navegador va al server.
  n.ydoc.on("update", (u: Uint8Array, origen: unknown) => {
    if (origen === "server") return;
    aplicarDeCliente(doc, u, n.generacion, { autor: nombre, socketId: nombre });
  });
  navegadores.push(n);
  return n;
}

/** Entrega lo pendiente a cada navegador. */
function entregar(): void {
  for (const n of navegadores) {
    for (const u of n.bandeja.splice(0)) Y.applyUpdate(n.ydoc, u, "server");
  }
}

function texto(y: Y.Doc): string {
  return y
    .getXmlFragment(FRAGMENTO)
    .toArray()
    .map((e) => (e instanceof Y.XmlElement ? e.toArray().map((t) => (t instanceof Y.XmlText ? t.toString() : "")).join("") : ""))
    .join("\n");
}

function parrafo(y: Y.Doc, contiene: string): Y.XmlText {
  for (const e of y.getXmlFragment(FRAGMENTO).toArray()) {
    if (!(e instanceof Y.XmlElement)) continue;
    const t = e.get(0);
    if (t instanceof Y.XmlText && t.toString().includes(contiene)) return t;
  }
  throw new Error(`no hay párrafo con "${contiene}"`);
}

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "multi-sync-"));
  // El reparto del server: a todos menos a quien lo mandó, y sin entregar aún.
  documentosVivos.alCambiar = (_doc, update, origen) => {
    for (const n of navegadores) if (n.nombre !== origen?.socketId) n.bandeja.push(update);
  };
  const agente = operacionesDeDocumento("sala-sync", dir, "agente-1");
  await agente.iniciar("Plan", [
    { titulo: "Uno", intencion: "a" },
    { titulo: "Dos", intencion: "b" },
  ]);
  const doc = documentosVivos.obtener("sala-sync")!;
  let leido = await agente.leer();
  const uno = leido.match(/«Uno» seccion=(\S+) huella_seccion=(\S+)/)!;
  await agente.escribirSeccion(uno[1], uno[2], "## Uno\n\nHola mundo.");

  console.log("\n1. Dos personas en el mismo párrafo");
  const ana = await conectar(doc, "Ana");
  const beto = await conectar(doc, "Beto");
  check("los dos abren lo mismo que el server", texto(ana.ydoc) === texto(doc.ydoc) && texto(beto.ydoc) === texto(doc.ydoc));
  // Sin entregar nada entre medio: escriben "al mismo tiempo".
  parrafo(ana.ydoc, "Hola").insert(0, "Ana: ");
  parrafo(beto.ydoc, "Hola").insert("Hola mundo.".length, " Beto estuvo aquí.");
  entregar();
  const final = texto(doc.ydoc);
  check("todos terminan con el mismo texto", texto(ana.ydoc) === final && texto(beto.ydoc) === final, `\n${texto(ana.ydoc)}\n---\n${texto(beto.ydoc)}`);
  check("y no se perdió nada de nadie", final.includes("Ana: Hola mundo. Beto estuvo aquí."), final);

  console.log("\n2. El agente y una persona a la vez");
  leido = await agente.leer();
  const dos = leido.match(/«Dos» seccion=(\S+) huella_seccion=(\S+)/)!;
  parrafo(ana.ydoc, "Hola").insert(0, "¡");
  await agente.escribirSeccion(dos[1], dos[2], "## Dos\n\nLo escribió el agente.");
  entregar();
  let juntos = texto(doc.ydoc);
  check("entra lo del agente", juntos.includes("Lo escribió el agente."));
  check("y lo de la persona", juntos.includes("¡Ana: Hola"));
  check("y los navegadores lo ven igual", texto(ana.ydoc) === juntos && texto(beto.ydoc) === juntos);
  check("la exportación lo refleja", exportarMarkdown(doc).includes("¡Ana: Hola mundo. Beto estuvo aquí."));

  console.log("\n3. Ids de bloque");
  // El id de un bloque es el de su elemento en Yjs: sigue igual aunque le cambien el texto.
  const idAntes = estado(doc).ids[estado(doc).bloques.findIndex((x) => JSON.stringify(x).includes("Ana: Hola"))];
  parrafo(beto.ydoc, "Hola").insert(0, "Otra vez ");
  entregar();
  const despues = estado(doc);
  check("el id de un párrafo no cambia al editarlo", despues.ids[despues.bloques.findIndex((x) => JSON.stringify(x).includes("Otra vez"))] === idAntes);
  check("y los navegadores ven los mismos ids", (() => {
    const deAna = ana.ydoc.getXmlFragment(FRAGMENTO).toArray().map((e) => idDeElemento(e as Y.XmlElement));
    return JSON.stringify(deAna) === JSON.stringify(despues.ids) && new Set(deAna).size === deAna.length;
  })());

  console.log("\n4. Lo que no entra");
  check("un cambio de una generación vieja pide recargar", aplicarDeCliente(doc, Y.encodeStateAsUpdate(ana.ydoc), doc.generacion - 1, { autor: "Ana" }) === "recargar");
  check("uno gigante se descarta", aplicarDeCliente(doc, new Uint8Array(MAX_UPDATE + 1), doc.generacion, { autor: "Ana" }) === "invalido");
  check("basura se descarta", aplicarDeCliente(doc, new Uint8Array([1, 2, 3, 250, 7]), doc.generacion, { autor: "Ana" }) === "invalido");
  check("algo que no son bytes se descarta", aplicarDeCliente(doc, "hola", doc.generacion, { autor: "Ana" }) === "invalido");
  const antes = texto(doc.ydoc);
  check("el documento sigue igual después de todo eso", texto(doc.ydoc) === antes);
  juntos = antes;
  check("un vector de estado roto igual sincroniza todo", (() => {
    const r = responderSync(doc, new Uint8Array([255, 255, 255]));
    const y = new Y.Doc();
    Y.applyUpdate(y, r.update);
    return texto(y) === juntos;
  })());

  await documentosVivos.cerrar("sala-sync");
  await rm(dir, { recursive: true, force: true });
  console.log(`\n${pass} pasaron, ${fail} fallaron`);
  if (fail > 0) process.exit(1);
}

void main();
