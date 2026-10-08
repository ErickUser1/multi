import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import { readFile, writeFile, rename, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { JSONContent } from "@tiptap/core";
import { Node as PMNode } from "@tiptap/pm/model";
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import {
  esquemaDelDocumento,
  markdownABloques,
  bloquesAMarkdown,
  hashDeBloque,
  type Objetos,
  type ObjetoDelDocumento,
} from "./doc-markdown.js";
import {
  ARCHIVO_MD,
  ARCHIVO_YJS,
  CARPETA_DOCUMENTO,
  esDocumentoViejo,
  leerDocumento,
} from "./documento.js";

/**
 * El documento vivo de cada sala: un Y.Doc en memoria que todos editan.
 *
 * Por qué Yjs y no archivos markdown: las personas editan el árbol de bloques
 * directo (como en Google Docs, varias en el mismo párrafo), y el agente lo
 * cambia por bloque con escritura condicional por hash. Nadie convierte el
 * documento entero ida y vuelta, así que guardar no reescribe lo que nadie tocó.
 *
 * Dentro del Y.Doc:
 * - "contenido": el árbol (XmlFragment), codificado igual que el editor
 *   (@tiptap/y-tiptap), así que el server y el navegador hablan lo mismo.
 * - "objetos": gráficas y diagramas por id. En el texto solo queda su ref.
 *
 * En disco, dentro del workspace (así el historial y volver atrás siguen
 * funcionando con el git de la sala):
 * - documento/doc.yjs: el estado, fuente de verdad.
 * - documento/documento.md: la exportación legible, para los diffs.
 */

export const FRAGMENTO = "contenido";
export const OBJETOS = "objetos";

/** Quién hizo un cambio. El socket va para no devolverle a nadie su propio cambio. */
export interface Origen {
  autor: string;
  socketId?: string;
}

export interface DocVivo {
  roomId: string;
  dir: string;
  ydoc: Y.Doc;
  /** Sube con cada cambio. Informativo para el agente. */
  revision: number;
  /**
   * Sube cada vez que el documento se recarga desde disco (volver atrás). Un
   * cliente con la generación anterior tiene un Y.Doc que ya no es este: sus
   * cambios se ignoran y tiene que recargar.
   */
  generacion: number;
  /** El último que tocó cada bloque de arriba, para decir quién cambió algo. */
  autorPorBloque: Map<string, { autor: string; en: number }>;
  /**
   * Quién está en el documento y dónde tiene el cursor. El server no tiene
   * cursor propio: solo junta lo de cada navegador para repartirlo y para
   * borrarlo cuando alguien se va (si no, su cursor se quedaría flotando).
   */
  awareness: Awareness;
  /** Los clientes de awareness que trajo cada socket. */
  awarenessPorSocket: Map<string, Set<number>>;
}

type AlCambiar = (doc: DocVivo, update: Uint8Array, origen: Origen | null) => void;
type AlCambiarAwareness = (doc: DocVivo, update: Uint8Array, socketId: string | null) => void;

const ESPERA_GUARDADO_MS = 1000;

class DocumentosVivos {
  private docs = new Map<string, DocVivo>();
  private abriendo = new Map<string, Promise<DocVivo | null>>();
  private guardados = new Map<string, Promise<void>>();
  private temporizadores = new Map<string, NodeJS.Timeout>();
  private generaciones = new Map<string, number>();
  /** Lo pone el server: reparte cada cambio a la sala. */
  alCambiar: AlCambiar = () => {};
  /** Lo pone el server: reparte los cursores. */
  alCambiarAwareness: AlCambiarAwareness = () => {};

  obtener(roomId: string): DocVivo | undefined {
    return this.docs.get(roomId);
  }

  /**
   * El documento de la sala, cargado de disco si hace falta. null si la sala no
   * es documento. Si es del formato anterior, se convierte aquí.
   */
  async abrir(roomId: string, dir: string): Promise<DocVivo | null> {
    const ya = this.docs.get(roomId);
    if (ya) return ya;
    const enCurso = this.abriendo.get(roomId);
    if (enCurso) return enCurso;
    const p = this.cargar(roomId, dir).finally(() => this.abriendo.delete(roomId));
    this.abriendo.set(roomId, p);
    return p;
  }

  private async cargar(roomId: string, dir: string): Promise<DocVivo | null> {
    const ruta = join(dir, CARPETA_DOCUMENTO, ARCHIVO_YJS);
    const ydoc = new Y.Doc();
    if (existsSync(ruta)) {
      Y.applyUpdate(ydoc, new Uint8Array(await readFile(ruta)));
    } else if (esDocumentoViejo(dir)) {
      await migrar(ydoc, dir);
    } else {
      return null;
    }
    const doc = this.registrar(roomId, dir, ydoc);
    // La migración se guarda de una vez: el formato viejo ya se borró.
    if (!existsSync(ruta)) await this.flush(roomId);
    return doc;
  }

  private registrar(roomId: string, dir: string, ydoc: Y.Doc): DocVivo {
    const awareness = new Awareness(ydoc);
    awareness.setLocalState(null);
    const doc: DocVivo = {
      roomId,
      dir,
      ydoc,
      revision: 0,
      generacion: this.generaciones.get(roomId) ?? 0,
      autorPorBloque: new Map(),
      awareness,
      awarenessPorSocket: new Map(),
    };
    awareness.on(
      "update",
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origen: unknown) => {
        const socketId = typeof origen === "string" && origen !== "server" ? origen : null;
        if (socketId) {
          const ids = doc.awarenessPorSocket.get(socketId) ?? new Set<number>();
          for (const id of [...added, ...updated]) ids.add(id);
          for (const id of removed) ids.delete(id);
          doc.awarenessPorSocket.set(socketId, ids);
        }
        const cambiados = [...added, ...updated, ...removed];
        if (cambiados.length) this.alCambiarAwareness(doc, encodeAwarenessUpdate(awareness, cambiados), socketId);
      },
    );
    ydoc.on("update", (update: Uint8Array, origen: unknown) => {
      doc.revision++;
      this.programarGuardado(roomId);
      this.alCambiar(doc, update, esOrigen(origen) ? origen : null);
    });
    ydoc.getXmlFragment(FRAGMENTO).observeDeep((eventos, tr) => {
      if (!esOrigen(tr.origin) || tr.origin.autor === "multi") return;
      const ahora = Date.now();
      for (const id of bloquesTocados(eventos, ydoc.getXmlFragment(FRAGMENTO))) {
        doc.autorPorBloque.set(id, { autor: tr.origin.autor, en: ahora });
      }
    });
    this.docs.set(roomId, doc);
    return doc;
  }

  /** Crea el documento de una sala que todavía no tiene. */
  async crear(roomId: string, dir: string, markdown: string, origen: Origen): Promise<DocVivo> {
    if (this.docs.has(roomId) || existsSync(join(dir, CARPETA_DOCUMENTO, ARCHIVO_YJS)) || esDocumentoViejo(dir)) {
      throw new Error("esta sala ya es un documento");
    }
    const doc = this.registrar(roomId, dir, new Y.Doc());
    aplicar(doc, origen, () => markdownABloques(markdown));
    await this.flush(roomId);
    return doc;
  }

  private programarGuardado(roomId: string): void {
    clearTimeout(this.temporizadores.get(roomId));
    this.temporizadores.set(
      roomId,
      setTimeout(() => void this.flush(roomId), ESPERA_GUARDADO_MS),
    );
  }

  /** Guarda ya lo que haya. Se encadena: dos guardados nunca se pisan. */
  async flush(roomId: string): Promise<void> {
    clearTimeout(this.temporizadores.get(roomId));
    this.temporizadores.delete(roomId);
    const doc = this.docs.get(roomId);
    if (!doc) return;
    const anterior = this.guardados.get(roomId) ?? Promise.resolve();
    const p = anterior.then(() => guardar(doc)).catch((err) => {
      console.error(`[sala ${roomId}] no se pudo guardar el documento:`, err);
    });
    this.guardados.set(roomId, p);
    await p;
  }

  async flushTodos(): Promise<void> {
    await Promise.all([...this.docs.keys()].map((id) => this.flush(id)));
  }

  /**
   * Vuelve a leer el documento de disco: después de volver atrás en el
   * historial, el archivo cambió por debajo. Sube la generación para que los
   * clientes tiren su copia.
   */
  async recargar(roomId: string, dir: string): Promise<DocVivo | null> {
    const viejo = this.docs.get(roomId);
    this.generaciones.set(roomId, (this.generaciones.get(roomId) ?? viejo?.generacion ?? 0) + 1);
    clearTimeout(this.temporizadores.get(roomId));
    this.temporizadores.delete(roomId);
    this.docs.delete(roomId);
    viejo?.awareness.destroy();
    viejo?.ydoc.destroy();
    return this.abrir(roomId, dir);
  }

  /** Guarda y suelta la memoria. Se vuelve a abrir solo cuando alguien lo pida. */
  async cerrar(roomId: string): Promise<void> {
    await this.flush(roomId);
    const doc = this.docs.get(roomId);
    this.docs.delete(roomId);
    doc?.awareness.destroy();
    doc?.ydoc.destroy();
  }
}

export const documentosVivos = new DocumentosVivos();

function esOrigen(o: unknown): o is Origen {
  return !!o && typeof o === "object" && typeof (o as Origen).autor === "string";
}

/** Los ids de los bloques de arriba que tocó un cambio. */
function bloquesTocados(eventos: Y.YEvent<Y.XmlElement | Y.XmlText>[], raiz: Y.XmlFragment): Set<string> {
  const ids = new Set<string>();
  for (const e of eventos) {
    if (e.target === raiz) {
      for (const item of e.changes.added) {
        for (const c of item.content.getContent()) {
          if (c instanceof Y.XmlElement) ids.add(idDeElemento(c));
        }
      }
      continue;
    }
    let t: Y.AbstractType<unknown> | null = e.target as Y.AbstractType<unknown>;
    while (t && t.parent !== raiz) t = t.parent as Y.AbstractType<unknown> | null;
    if (t instanceof Y.XmlElement) ids.add(idDeElemento(t));
  }
  return ids;
}

// ── Leer y cambiar ───────────────────────────────────────────────────────────

/**
 * El id de un bloque: el de su elemento en Yjs (cliente.reloj, en base 36).
 *
 * Único por construcción, nadie lo asigna y no viaja como atributo (ver
 * doc-esquema.ts). Mientras el bloque exista, aunque le cambien el texto, su
 * id es el mismo; un bloque reemplazado es otro bloque y trae otro.
 */
export function idDeElemento(e: Y.XmlElement | Y.AbstractType<unknown>): string {
  const item = e._item;
  return item ? `${item.id.client.toString(36)}.${item.id.clock.toString(36)}` : "?";
}

/** Los bloques de arriba con su id, y los objetos, tal como están ahora. */
export function estado(doc: DocVivo): { bloques: JSONContent[]; ids: string[]; objetos: Objetos } {
  const fragmento = doc.ydoc.getXmlFragment(FRAGMENTO);
  const raiz = yXmlFragmentToProseMirrorRootNode(fragmento, esquemaDelDocumento());
  const objetos: Objetos = {};
  doc.ydoc.getMap<ObjetoDelDocumento>(OBJETOS).forEach((v, k) => {
    objetos[k] = { tipo: v.tipo, fuente: v.fuente };
  });
  // Cada hijo del árbol corresponde, en orden, a un elemento del fragmento.
  const ids = fragmento.toArray().filter((e) => e instanceof Y.XmlElement).map(idDeElemento);
  return { bloques: (raiz.toJSON().content ?? []) as JSONContent[], ids, objetos };
}

/**
 * Cambia el documento: `f` recibe los bloques actuales y devuelve los nuevos,
 * más los objetos que agrega. Se aplica como diferencia mínima
 * (updateYFragment), así que quien escribe en otro párrafo no nota nada.
 */
export function aplicar(
  doc: DocVivo,
  origen: Origen,
  f: (actual: { bloques: JSONContent[]; ids: string[]; objetos: Objetos }) => { bloques: JSONContent[]; objetos?: Objetos },
): string[] {
  const actual = estado(doc);
  const nuevo = f(actual);
  const esquema = esquemaDelDocumento();
  const raiz = PMNode.fromJSON(esquema, { type: "doc", content: nuevo.bloques });
  // Lo valida antes de tocar nada: un árbol que el esquema no acepta no entra.
  raiz.check();
  const fragmento = doc.ydoc.getXmlFragment(FRAGMENTO);
  const mapa = doc.ydoc.getMap<ObjetoDelDocumento>(OBJETOS);
  doc.ydoc.transact(() => {
    for (const [id, obj] of Object.entries(nuevo.objetos ?? {})) mapa.set(id, obj);
    updateYFragment(doc.ydoc, fragmento, raiz, { mapping: new Map(), isOMark: new Map() } as never);
    // Los objetos que ya nadie usa NO se borran aquí: una persona pudo haber
    // creado una gráfica cuyo bloque todavía viene en camino, y borrarle los
    // datos se los perdería. Un objeto huérfano pesa unos bytes.
  }, origen);
  // Los ids como quedaron: los bloques que no cambiaron conservan el suyo.
  return estado(doc).ids;
}

/** Cambia el contenido de un objeto (los datos de una gráfica, el SVG de un diagrama). */
export function cambiarObjeto(doc: DocVivo, origen: Origen, ref: string, fuente: string): void {
  const mapa = doc.ydoc.getMap<ObjetoDelDocumento>(OBJETOS);
  const obj = mapa.get(ref);
  if (!obj) throw new Error(`no existe el objeto ${ref}`);
  doc.ydoc.transact(() => mapa.set(ref, { tipo: obj.tipo, fuente }), origen);
}

/** El markdown completo, sin ids: la exportación. */
export function exportarMarkdown(doc: DocVivo): string {
  const { bloques, objetos } = estado(doc);
  return bloquesAMarkdown(bloques, objetos);
}

/** El texto del primer título: el nombre del documento. */
export function tituloDe(doc: DocVivo): string {
  const { bloques } = estado(doc);
  const h = bloques.find((b) => b.type === "heading");
  return textoDe(h);
}

export function textoDe(n: JSONContent | undefined): string {
  if (!n) return "";
  if (n.type === "text") return n.text ?? "";
  return (n.content ?? []).map(textoDe).join("");
}

export { hashDeBloque };

// ── Sincronía con los clientes ───────────────────────────────────────────────

/** Un cambio más grande que esto no es una edición: se descarta. */
export const MAX_UPDATE = 1024 * 1024;

function bytes(x: unknown): Uint8Array | null {
  if (x instanceof Uint8Array) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  return null;
}

/**
 * Paso 1 de la sincronía de Yjs: el cliente dice qué tiene (su vector de
 * estado) y recibe lo que le falta, más el vector del server para que le
 * mande lo suyo.
 */
export function responderSync(
  doc: DocVivo,
  vector: unknown,
): { update: Uint8Array; vector: Uint8Array; generacion: number; awareness: Uint8Array } {
  const v = bytes(vector);
  let update: Uint8Array;
  try {
    update = Y.encodeStateAsUpdate(doc.ydoc, v ?? undefined);
  } catch {
    // Un vector que no se entiende: se manda todo, que también sincroniza.
    update = Y.encodeStateAsUpdate(doc.ydoc);
  }
  return {
    update,
    vector: Y.encodeStateVector(doc.ydoc),
    generacion: doc.generacion,
    // Quién más está y dónde: sin esto, el que llega no ve los cursores de los
    // que ya estaban hasta que se muevan.
    awareness: encodeAwarenessUpdate(doc.awareness, [...doc.awareness.getStates().keys()]),
  };
}

/** Un cambio de cursor o de presencia de un navegador. */
export function aplicarAwareness(doc: DocVivo, update: unknown, socketId: string): boolean {
  const u = bytes(update);
  if (!u || u.byteLength > 64 * 1024) return false;
  try {
    applyAwarenessUpdate(doc.awareness, u, socketId);
    return true;
  } catch {
    return false;
  }
}

/** Alguien se fue: sus cursores se borran para todos. */
export function quitarAwarenessDe(doc: DocVivo, socketId: string): void {
  const ids = doc.awarenessPorSocket.get(socketId);
  doc.awarenessPorSocket.delete(socketId);
  if (ids?.size) removeAwarenessStates(doc.awareness, [...ids], "server");
}

/**
 * Un cambio que manda un cliente. Lo que no es un cambio válido, lo que pesa de
 * más y lo que viene de una generación anterior (un Y.Doc que ya no existe
 * porque alguien volvió atrás) no entra.
 */
export function aplicarDeCliente(
  doc: DocVivo,
  update: unknown,
  generacion: unknown,
  origen: Origen,
): "ok" | "recargar" | "invalido" {
  const u = bytes(update);
  if (!u || u.byteLength > MAX_UPDATE) return "invalido";
  if (generacion !== doc.generacion) return "recargar";
  try {
    Y.applyUpdate(doc.ydoc, u, origen);
    return "ok";
  } catch {
    return "invalido";
  }
}

// ── Disco ────────────────────────────────────────────────────────────────────

async function escribirAtomico(ruta: string, contenido: string | Uint8Array): Promise<void> {
  const tmp = `${ruta}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, contenido);
  await rename(tmp, ruta);
}

async function guardar(doc: DocVivo): Promise<void> {
  const carpeta = join(doc.dir, CARPETA_DOCUMENTO);
  await mkdir(carpeta, { recursive: true });
  await escribirAtomico(join(carpeta, ARCHIVO_YJS), Y.encodeStateAsUpdate(doc.ydoc));
  await escribirAtomico(join(carpeta, ARCHIVO_MD), `${exportarMarkdown(doc)}\n`);
}

/**
 * Convierte un documento del formato de archivos markdown (#109) al vivo. Lo
 * viejo se borra: el historial de la sala lo conserva si alguien vuelve atrás.
 */
async function migrar(ydoc: Y.Doc, dir: string): Promise<void> {
  const viejo = await leerDocumento(dir);
  const partes: string[] = [];
  if (viejo?.titulo) partes.push(`# ${viejo.titulo}`);
  for (const s of viejo?.secciones ?? []) {
    if (s.markdown) partes.push(s.markdown);
    if (s.pendiente !== null) partes.push(`<!-- pendiente: ${s.pendiente.replace(/-->/g, "—")} -->`);
  }
  const { bloques, objetos } = markdownABloques(partes.join("\n\n"));
  const temporal: DocVivo = {
    roomId: "",
    dir,
    ydoc,
    revision: 0,
    generacion: 0,
    autorPorBloque: new Map(),
    awareness: new Awareness(ydoc),
    awarenessPorSocket: new Map(),
  };
  aplicar(temporal, { autor: "multi" }, () => ({ bloques, objetos }));
  const carpeta = join(dir, CARPETA_DOCUMENTO);
  await rm(join(carpeta, "documento.json"), { force: true });
  await rm(join(carpeta, "secciones"), { recursive: true, force: true });
}

/**
 * Lo que las personas cambiaron en el documento desde `desde`, por autor y por
 * sección. Va en el contexto del agente al empezar su turno: si alguien
 * corrigió el presupuesto a mano, el agente tiene que saberlo antes de tocarlo.
 */
export function cambiosDePersonasDesde(doc: DocVivo, desde: number, agentes: Set<string>): Map<string, string[]> {
  const { bloques, ids } = estado(doc);
  const seccionDe = new Map<string, string>();
  let actual = "";
  bloques.forEach((b, i) => {
    if (b.type === "heading") actual = textoDe(b);
    seccionDe.set(ids[i], actual || "(inicio)");
  });
  const porAutor = new Map<string, string[]>();
  for (const [id, { autor, en }] of doc.autorPorBloque) {
    if (en < desde || agentes.has(autor) || autor === "multi") continue;
    const seccion = seccionDe.get(id);
    if (!seccion) continue;
    const lista = porAutor.get(autor) ?? [];
    if (!lista.includes(seccion)) lista.push(seccion);
    porAutor.set(autor, lista);
  }
  return porAutor;
}
