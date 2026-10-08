import type * as Y from "yjs";
import type { Extensions, AnyExtension, Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { graficaSvg } from "./grafica";
import { diagramaSeguro } from "./svg-seguro";

/**
 * Cómo se pintan en el navegador los bloques que no son texto.
 *
 * El esquema (esquema.ts) dice qué son; esto dice cómo se ven. Va aparte para
 * que el esquema siga idéntico al del server.
 *
 * Las gráficas y los diagramas guardan solo su `ref`: los datos viven en el
 * mapa de objetos del Y.Doc. Cada vista escucha ese mapa y se redibuja cuando
 * alguien cambia los datos, aunque el texto alrededor no se haya movido.
 */

interface Objeto {
  tipo: "grafica" | "diagrama";
  fuente: string;
}

function vistaDeObjeto(
  objetos: Y.Map<Objeto>,
  clase: string,
  dibujar: (fuente: string) => string,
  aviso: string,
  alAbrir?: (ref: string) => void,
) {
  return ({ node, editor }: { node: PMNode; editor: Editor }) => {
    const dom = document.createElement("figure");
    dom.className = clase;
    dom.contentEditable = "false";
    let ref = String(node.attrs.ref ?? "");
    // Doble clic abre sus datos (un clic solo la selecciona, para moverla o borrarla).
    if (alAbrir) {
      dom.addEventListener("dblclick", () => {
        if (editor.isEditable) alAbrir(ref);
      });
    }
    const pintar = () => {
      const obj = objetos.get(ref);
      const html = obj ? dibujar(obj.fuente) : "";
      if (html) {
        dom.innerHTML = html;
      } else {
        dom.innerHTML = "";
        const div = document.createElement("div");
        div.className = "doc-aviso";
        div.textContent = aviso;
        dom.appendChild(div);
      }
    };
    const alCambiar = (e: Y.YMapEvent<Objeto>) => {
      if (e.keysChanged.has(ref)) pintar();
    };
    objetos.observe(alCambiar);
    pintar();
    return {
      dom,
      update(nuevo: PMNode) {
        if (nuevo.type !== node.type) return false;
        const r = String(nuevo.attrs.ref ?? "");
        if (r !== ref) {
          ref = r;
          pintar();
        }
        return true;
      },
      destroy() {
        objetos.unobserve(alCambiar);
      },
      ignoreMutation: () => true,
    };
  };
}

export function conVistas(
  extensiones: Extensions,
  opts: {
    objetos: Y.Map<Objeto>;
    urlImagen: (nombre: string) => string;
    escribiendo: string;
    /** Abrir los datos de una gráfica para editarlos. */
    alAbrirGrafica?: (ref: string) => void;
  },
): Extensions {
  const vistas: Record<string, (ext: AnyExtension) => AnyExtension> = {
    grafica: (ext) =>
      ext.extend({
        addNodeView: () =>
          vistaDeObjeto(opts.objetos, "doc-grafica", (f) => graficaSvg(f) ?? "", "No se pudo dibujar esta gráfica.", opts.alAbrirGrafica),
      }),
    diagrama: (ext) =>
      ext.extend({
        addNodeView: () => vistaDeObjeto(opts.objetos, "doc-diagrama", diagramaSeguro, "No se pudo dibujar este diagrama."),
      }),
    pendiente: (ext) =>
      ext.extend({
        addNodeView: () => ({ node, editor, getPos }: { node: PMNode; editor: Editor; getPos: () => number | undefined }) => {
          const dom = document.createElement("div");
          dom.className = "doc-pendiente";
          // Clic en una sección pendiente: la escribes tú. Se vuelve un párrafo vacío con el cursor adentro.
          dom.addEventListener("mousedown", (e) => {
            const pos = getPos();
            if (!editor.isEditable || pos === undefined) return;
            e.preventDefault();
            editor
              .chain()
              .focus()
              .insertContentAt({ from: pos, to: pos + node.nodeSize }, { type: "paragraph" })
              .setTextSelection(pos + 1)
              .run();
          });
          dom.contentEditable = "false";
          dom.setAttribute("aria-busy", "true");
          const que = document.createElement("span");
          que.className = "doc-pendiente-que";
          que.textContent = String(node.attrs.intencion || opts.escribiendo);
          dom.appendChild(que);
          for (const corta of [false, false, true]) {
            const l = document.createElement("span");
            l.className = corta ? "doc-linea corta" : "doc-linea";
            dom.appendChild(l);
          }
          return { dom, ignoreMutation: () => true };
        },
      }),
    imagen: (ext) =>
      ext.extend({
        addNodeView: () => ({ node }: { node: PMNode }) => {
          const dom = document.createElement("figure");
          dom.className = "doc-imagen";
          dom.contentEditable = "false";
          const src = String(node.attrs.src ?? "").replace(/^\.?\//, "");
          const local = src.match(/^(?:documento\/)?imagenes\/([^/?#]+)$/);
          // Solo las imágenes de la sala o de https: lo demás no se carga.
          const url = local ? opts.urlImagen(local[1]) : /^https:\/\//i.test(src) ? src : "";
          if (url) {
            const img = document.createElement("img");
            img.src = url;
            img.alt = String(node.attrs.alt ?? "");
            img.loading = "lazy";
            dom.appendChild(img);
          }
          return { dom, ignoreMutation: () => true };
        },
      }),
  };
  return extensiones.map((e) => (vistas[e.name] ? vistas[e.name](e) : e));
}
