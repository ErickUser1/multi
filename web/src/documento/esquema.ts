/**
 * El esquema del documento: qué bloques y qué marcas existen.
 *
 * ESTE ARCHIVO VIVE DOS VECES, idéntico: server/src/engine/doc-esquema.ts y
 * web/src/documento/esquema.ts. El server convierte el markdown del agente a
 * bloques y el navegador los edita; si los dos no entienden exactamente los
 * mismos nodos, lo que uno escribe el otro no lo puede leer y Yjs lo descarta.
 * No hay paquete compartido en el monorepo, así que demo:doc-vivo falla si las
 * dos copias difieren.
 *
 * Los bloques de arriba llevan un `id` estable: es lo que el agente cita para
 * cambiar uno sin reescribir el resto, y a lo que se anclan los comentarios.
 */
import { Node, mergeAttributes, type Extensions } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import UniqueID from "@tiptap/extension-unique-id";
import type { Transaction } from "@tiptap/pm/state";

/** Los bloques que llevan id. Las celdas y los items de lista no: se citan por su tabla o su lista. */
export const TIPOS_CON_ID = [
  "paragraph",
  "heading",
  "bulletList",
  "orderedList",
  "blockquote",
  "codeBlock",
  "horizontalRule",
  "table",
  "imagen",
  "grafica",
  "diagrama",
  "pendiente",
];

/** Una gráfica: en el texto solo queda la referencia; los datos viven en el mapa de objetos. */
const Grafica = Node.create({
  name: "grafica",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return { ref: { default: null } };
  },
  parseHTML() {
    return [{ tag: "figure[data-grafica]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["figure", mergeAttributes(HTMLAttributes, { "data-grafica": "" })];
  },
});

/** Un diagrama: igual que la gráfica, el SVG vive en el mapa de objetos. */
const Diagrama = Node.create({
  name: "diagrama",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return { ref: { default: null } };
  },
  parseHTML() {
    return [{ tag: "figure[data-diagrama]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["figure", mergeAttributes(HTMLAttributes, { "data-diagrama": "" })];
  },
});

/** Lo que falta escribir en una sección, con lo que va a llevar. */
const Pendiente = Node.create({
  name: "pendiente",
  group: "block",
  atom: true,
  addAttributes() {
    return { intencion: { default: "" } };
  },
  parseHTML() {
    return [{ tag: "div[data-pendiente]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-pendiente": "" })];
  },
});

/**
 * Una imagen. `src` es el nombre de un archivo de documento/imagenes/ o una URL
 * https; quien la pinta decide de dónde se sirve.
 */
const Imagen = Node.create({
  name: "imagen",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return { src: { default: "" }, alt: { default: "" } };
  },
  parseHTML() {
    return [{ tag: "img[data-imagen]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["img", mergeAttributes(HTMLAttributes, { "data-imagen": "" })];
  },
});

/**
 * Las extensiones que definen el esquema. Quien edita (el navegador) les suma
 * las de colaboración; quien convierte (el server) usa solo estas.
 *
 * - `soloLectura`: no le pone ids a nada (sería una edición que nadie hizo).
 * - `filtroIds`: qué transacciones reciben ids nuevos. Con colaboración, solo
 *   las propias: si cada navegador les pusiera id a los bloques que llegan de
 *   otro, el mismo bloque acabaría con ids distintos en cada lado.
 */
export function extensionesDelDocumento(
  opciones: { soloLectura?: boolean; filtroIds?: (tr: Transaction) => boolean } = {},
): Extensions {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      // Deshacer lo lleva Yjs (solo lo propio), y subrayado no existe en markdown.
      undoRedo: false,
      underline: false,
      // El nodo final automático es una edición que nadie hizo: con varias
      // personas conectadas, cada una lo agregaría al abrir.
      trailingNode: false,
      link: { openOnClick: false, autolink: true },
    }),
    TableKit.configure({ table: { resizable: false } }),
    Grafica,
    Diagrama,
    Pendiente,
    Imagen,
    UniqueID.configure({
      types: TIPOS_CON_ID,
      updateDocument: !opciones.soloLectura,
      filterTransaction: opciones.filtroIds ?? null,
    }),
  ];
}
