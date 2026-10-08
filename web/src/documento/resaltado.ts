import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { rangoDeAncla, type Ancla } from "./anclas";

/**
 * El texto comentado, resaltado en la hoja.
 *
 * Las anclas se resuelven en cada pintada: son posiciones relativas de Yjs, así
 * que el resaltado sigue a su frase aunque alguien escriba antes o en medio.
 * El hilo activo se resalta más fuerte; un clic en un resaltado lo activa.
 */
export interface HiloResaltado {
  hilo: string;
  ancla: Ancla;
}

export const llaveResaltado = new PluginKey<{ hilos: HiloResaltado[]; activo: string | null }>("resaltadoDeComentarios");

export const ResaltadoDeComentarios = Extension.create<{ alActivar: (hilo: string) => void }>({
  name: "resaltadoDeComentarios",
  addOptions() {
    return { alActivar: () => {} };
  },
  addProseMirrorPlugins() {
    const alActivar = this.options.alActivar;
    return [
      new Plugin({
        key: llaveResaltado,
        state: {
          init: () => ({ hilos: [], activo: null }),
          apply(tr, actual) {
            return (tr.getMeta(llaveResaltado) as typeof actual | undefined) ?? actual;
          },
        },
        props: {
          decorations(state) {
            const { hilos, activo } = llaveResaltado.getState(state) ?? { hilos: [], activo: null };
            if (!hilos.length) return null;
            const decos: Decoration[] = [];
            for (const h of hilos) {
              const r = rangoDeAncla(state, h.ancla);
              if (!r) continue;
              const clase = h.hilo === activo ? "doc-comentado activo" : "doc-comentado";
              decos.push(
                "objeto" in h.ancla
                  ? Decoration.node(r.from, r.to, { class: clase, "data-hilo": h.hilo })
                  : Decoration.inline(r.from, r.to, { class: clase, "data-hilo": h.hilo }),
              );
            }
            return DecorationSet.create(state.doc, decos);
          },
          handleClick(_view, _pos, evento) {
            const hilo = (evento.target as HTMLElement | null)?.closest?.("[data-hilo]")?.getAttribute("data-hilo");
            if (hilo) alActivar(hilo);
            return false;
          },
        },
      }),
    ];
  },
});
