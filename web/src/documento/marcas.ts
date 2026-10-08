import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type * as Y from "yjs";

/** El id de un bloque: el de su elemento en Yjs, igual que lo calcula el server (doc-vivo.ts). */
export function idDeElemento(e: { _item: Y.Item | null } | undefined): string {
  const item = e?._item;
  return item ? `${item.id.client.toString(36)}.${item.id.clock.toString(36)}` : "?";
}

/**
 * Dónde está escribiendo cada agente, marcado en la hoja.
 *
 * El agente no tiene cursor (escribe bloques enteros desde el server), así que
 * en vez de un caret se marcan los bloques que acaba de tocar, con su nombre y
 * su color. Llega por `doc:agente` y se borra cuando termina su turno.
 */
export interface DondeEscribe {
  agente: string;
  color: string;
  bloques: string[];
  /** Lo que dice la etiqueta, ya en el idioma de quien mira. */
  etiqueta?: string;
}

export const llaveMarcas = new PluginKey<Map<string, DondeEscribe>>("marcasDeAgentes");

export const MarcasDeAgentes = Extension.create<{ fragmento: Y.XmlFragment | null }>({
  name: "marcasDeAgentes",
  addOptions() {
    return { fragmento: null };
  },
  addProseMirrorPlugins() {
    const fragmento = this.options.fragmento;
    return [
      new Plugin<Map<string, DondeEscribe>>({
        key: llaveMarcas,
        state: {
          init: () => new Map(),
          apply(tr, actual) {
            const nueva = tr.getMeta(llaveMarcas) as DondeEscribe | undefined;
            if (!nueva) return actual;
            const m = new Map(actual);
            if (nueva.bloques.length) m.set(nueva.agente, nueva);
            else m.delete(nueva.agente);
            return m;
          },
        },
        props: {
          decorations(state) {
            const marcas = llaveMarcas.getState(state);
            if (!marcas?.size) return null;
            const porBloque = new Map<string, DondeEscribe>();
            for (const m of marcas.values()) for (const id of m.bloques) porBloque.set(id, m);
            const decos: Decoration[] = [];
            let primero = new Set<string>();
            // Los hijos del documento van en el mismo orden que los elementos del fragmento.
            const elementos = fragmento?.toArray() ?? [];
            state.doc.forEach((nodo, pos, i) => {
              const m = porBloque.get(idDeElemento(elementos[i]));
              if (!m) return;
              // El nombre solo en el primer bloque de cada agente: en los demás
              // basta la raya de su color.
              const conNombre = !primero.has(m.agente);
              primero.add(m.agente);
              decos.push(
                Decoration.node(pos, pos + nodo.nodeSize, {
                  class: conNombre ? "doc-agente-aqui con-nombre" : "doc-agente-aqui",
                  "data-etiqueta": m.etiqueta ?? m.agente,
                  style: `--color-agente: ${m.color}`,
                }),
              );
            });
            primero = new Set();
            return DecorationSet.create(state.doc, decos);
          },
        },
      }),
    ];
  },
});
