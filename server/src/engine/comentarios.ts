import * as Y from "yjs";
import { FRAGMENTO, OBJETOS, idDeElemento, estado, textoDe, type DocVivo } from "./doc-vivo.js";

/**
 * Dónde está un comentario dentro del documento.
 *
 * Un comentario de texto se ancla con posiciones RELATIVAS de Yjs: apuntan a
 * los caracteres mismos (cliente.reloj de cada uno), no a un número de
 * posición. Si alguien escribe antes, el ancla sigue pegada a su frase; si se
 * borra la frase, el ancla queda vacía y el hilo muestra la cita guardada.
 *
 * Una gráfica o un diagrama se comentan enteros, por su objeto.
 */
export type Ancla =
  | { bloque: string; inicio: string; fin: string }
  | { bloque: string; objeto: string };

const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const deB64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

/** El texto plano de un XmlText, sin marcas. */
function textoPlano(t: Y.XmlText): string {
  return (t.toDelta() as { insert: unknown }[]).map((d) => (typeof d.insert === "string" ? d.insert : "")).join("");
}

/** Todos los XmlText dentro de un elemento (en una tabla, los de cada celda). */
function textosDe(e: Y.XmlElement): Y.XmlText[] {
  const r: Y.XmlText[] = [];
  for (const h of e.toArray()) {
    if (h instanceof Y.XmlText) r.push(h);
    else if (h instanceof Y.XmlElement) r.push(...textosDe(h));
  }
  return r;
}

function elementoPorId(doc: DocVivo, bloque: string): Y.XmlElement | null {
  for (const e of doc.ydoc.getXmlFragment(FRAGMENTO).toArray()) {
    if (e instanceof Y.XmlElement && idDeElemento(e) === bloque) return e;
  }
  return null;
}

/**
 * El ancla de una cita dentro de un bloque: lo que usa el agente para comentar
 * algo concreto. null si la cita no está tal cual en ese bloque.
 */
export function anclaDeCita(doc: DocVivo, bloque: string, cita: string): Ancla | null {
  const e = elementoPorId(doc, bloque);
  if (!e || !cita) return null;
  if (e.nodeName === "grafica" || e.nodeName === "diagrama") {
    const ref = e.getAttribute("ref");
    return typeof ref === "string" ? { bloque, objeto: ref } : null;
  }
  for (const t of textosDe(e)) {
    const i = textoPlano(t).indexOf(cita);
    if (i < 0) continue;
    return {
      bloque,
      inicio: b64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(t, i))),
      // assoc -1: el final se pega al último carácter de la cita, no al que sigue.
      fin: b64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(t, i + cita.length, -1))),
    };
  }
  return null;
}

/** El texto que hoy cubre un ancla. null si ya no existe (se borró). */
export function textoDeAncla(doc: DocVivo, ancla: Ancla): string | null {
  if ("objeto" in ancla) return doc.ydoc.getMap(OBJETOS).has(ancla.objeto) ? "" : null;
  try {
    const a = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(deB64(ancla.inicio)), doc.ydoc);
    const b = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(deB64(ancla.fin)), doc.ydoc);
    if (!a || !b || a.type !== b.type || !(a.type instanceof Y.XmlText) || b.index <= a.index) return null;
    return textoPlano(a.type).slice(a.index, b.index);
  } catch {
    return null;
  }
}

/** Un ancla que llega de un navegador: se acepta solo si tiene la forma esperada y no pesa de más. */
export function anclaValida(x: unknown): Ancla | null {
  if (!x || typeof x !== "object") return null;
  const a = x as Record<string, unknown>;
  const corto = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max;
  if (!corto(a.bloque, 40)) return null;
  if (corto(a.objeto, 40)) return { bloque: String(a.bloque), objeto: String(a.objeto) };
  if (corto(a.inicio, 400) && corto(a.fin, 400)) {
    return { bloque: String(a.bloque), inicio: String(a.inicio), fin: String(a.fin) };
  }
  return null;
}

/** El título de la sección donde vive un bloque, para decir "comentó en «Presupuesto»". */
export function seccionDeBloque(doc: DocVivo, bloque: string): string {
  const { bloques, ids } = estado(doc);
  let actual = "";
  for (let i = 0; i < bloques.length; i++) {
    if (bloques[i].type === "heading") actual = textoDe(bloques[i]);
    if (ids[i] === bloque) return actual || "el inicio";
  }
  return "el documento";
}
