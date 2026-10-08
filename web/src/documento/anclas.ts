import * as Y from "yjs";
import type { EditorState } from "@tiptap/pm/state";
import { NodeSelection } from "@tiptap/pm/state";
import { ySyncPluginKey, absolutePositionToRelativePosition, relativePositionToAbsolutePosition } from "@tiptap/y-tiptap";
import { idDeElemento } from "./marcas";

/**
 * Las anclas de los comentarios, del lado del navegador. Mismo formato que el
 * server (engine/comentarios.ts): posiciones relativas de Yjs en base64, que
 * apuntan a los caracteres y no a un número de posición.
 */
export type Ancla = { bloque: string; inicio: string; fin: string } | { bloque: string; objeto: string };

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const deB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

interface Binding {
  doc: Y.Doc;
  type: Y.XmlFragment;
  mapping: Map<unknown, unknown>;
}

function binding(state: EditorState): Binding | null {
  return (ySyncPluginKey.getState(state)?.binding as Binding | undefined) ?? null;
}

/** El ancla de lo seleccionado ahora, con la cita. null si no hay nada que comentar. */
export function anclaDeSeleccion(state: EditorState): { ancla: Ancla; cita: string } | null {
  const b = binding(state);
  const { from, to } = state.selection;
  if (!b || from === to) return null;
  const bloque = idDeElemento(b.type.get(state.doc.resolve(from).index(0)) as Y.XmlElement);

  // Una gráfica o un diagrama seleccionados: se comenta el objeto entero.
  const sel = state.selection;
  if (sel instanceof NodeSelection && (sel.node.type.name === "grafica" || sel.node.type.name === "diagrama")) {
    return {
      ancla: { bloque, objeto: String(sel.node.attrs.ref) },
      cita: sel.node.type.name === "grafica" ? "gráfica" : "diagrama",
    };
  }
  // Solo dentro de un mismo bloque de texto: un comentario sobre tres párrafos
  // no tiene a qué frase pegarse.
  if (state.doc.resolve(from).parent !== state.doc.resolve(to).parent) return null;
  const cita = state.doc.textBetween(from, to, " ").trim();
  if (!cita) return null;

  const inicio = absolutePositionToRelativePosition(from, b.type, b.mapping as never);
  // El final se pega al último carácter de la cita (assoc -1), no al que sigue:
  // lo que alguien escriba justo después no entra al comentario.
  const finAbs = Y.createAbsolutePositionFromRelativePosition(absolutePositionToRelativePosition(to, b.type, b.mapping as never), b.doc);
  if (!finAbs) return null;
  const fin = Y.createRelativePositionFromTypeIndex(finAbs.type, finAbs.index, -1);
  return {
    ancla: { bloque, inicio: b64(Y.encodeRelativePosition(inicio)), fin: b64(Y.encodeRelativePosition(fin)) },
    cita: cita.slice(0, 500),
  };
}

/** Dónde está hoy un ancla en el editor. null si su texto ya no existe. */
export function rangoDeAncla(state: EditorState, ancla: Ancla): { from: number; to: number } | null {
  const b = binding(state);
  if (!b) return null;
  if ("objeto" in ancla) {
    let r: { from: number; to: number } | null = null;
    state.doc.forEach((n, pos) => {
      if (!r && n.attrs.ref === ancla.objeto) r = { from: pos, to: pos + n.nodeSize };
    });
    return r;
  }
  try {
    const from = relativePositionToAbsolutePosition(b.doc, b.type, Y.decodeRelativePosition(deB64(ancla.inicio)), b.mapping as never);
    const to = relativePositionToAbsolutePosition(b.doc, b.type, Y.decodeRelativePosition(deB64(ancla.fin)), b.mapping as never);
    if (from === null || to === null || to <= from) return null;
    return { from, to };
  } catch {
    return null;
  }
}
