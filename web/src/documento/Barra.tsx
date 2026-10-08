import { useEffect, useReducer } from "react";
import type { Editor } from "@tiptap/core";
import { useTextos } from "../i18n";

/**
 * La barra de formato del documento.
 *
 * Fija arriba de la hoja y no flotante: en el celular una barra que sigue a la
 * selección queda debajo del teclado o encima del texto. Lo de tablas solo
 * aparece con el cursor dentro de una.
 */
export function Barra({ editor, alInsertarGrafica }: { editor: Editor; alInsertarGrafica: () => void }) {
  const { t } = useTextos();
  // Se repinta con cada cambio de selección: los botones dicen qué está activo.
  const [, repintar] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    editor.on("transaction", repintar);
    return () => {
      editor.off("transaction", repintar);
    };
  }, [editor]);

  const c = () => editor.chain().focus();
  const boton = (etiqueta: string, titulo: string, activo: boolean, accion: () => void, clase = "") => (
    <button
      type="button"
      className={`doc-herramienta ${activo ? "activa" : ""} ${clase}`}
      title={titulo}
      aria-label={titulo}
      aria-pressed={activo}
      // mousedown y no click: con click el editor pierde la selección antes.
      onMouseDown={(e) => {
        e.preventDefault();
        accion();
      }}
    >
      {etiqueta}
    </button>
  );

  const enlace = () => {
    const actual = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt(t.docUrlEnlace, actual ?? "https://");
    if (url === null) return;
    if (!url.trim()) c().unsetLink().run();
    else if (/^https?:\/\//i.test(url.trim())) c().setLink({ href: url.trim() }).run();
  };

  const enTabla = editor.isActive("table");

  return (
    <div className="doc-herramientas" role="toolbar" aria-label={t.docFormato}>
      {boton("B", t.docNegrita, editor.isActive("bold"), () => c().toggleBold().run(), "negrita")}
      {boton("I", t.docCursiva, editor.isActive("italic"), () => c().toggleItalic().run(), "cursiva")}
      {boton("S", t.docTachado, editor.isActive("strike"), () => c().toggleStrike().run(), "tachado")}
      {boton("🔗", t.docEnlace, editor.isActive("link"), enlace)}
      <span className="doc-sep" />
      {boton("H1", t.docTitulo1, editor.isActive("heading", { level: 1 }), () => c().toggleHeading({ level: 1 }).run())}
      {boton("H2", t.docTitulo2, editor.isActive("heading", { level: 2 }), () => c().toggleHeading({ level: 2 }).run())}
      {boton("H3", t.docTitulo3, editor.isActive("heading", { level: 3 }), () => c().toggleHeading({ level: 3 }).run())}
      <span className="doc-sep" />
      {boton("•", t.docLista, editor.isActive("bulletList"), () => c().toggleBulletList().run())}
      {boton("1.", t.docListaNumerada, editor.isActive("orderedList"), () => c().toggleOrderedList().run())}
      {boton("❝", t.docCita, editor.isActive("blockquote"), () => c().toggleBlockquote().run())}
      <span className="doc-sep" />
      {boton("▦", t.docInsertarTabla, false, () => c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run())}
      {boton("▮▯", t.docInsertarGrafica, false, alInsertarGrafica)}
      {boton("―", t.docSeparador, false, () => c().setHorizontalRule().run())}
      {enTabla && (
        <>
          <span className="doc-sep" />
          {boton("+fila", t.docFilaAbajo, false, () => c().addRowAfter().run())}
          {boton("+col", t.docColumnaDerecha, false, () => c().addColumnAfter().run())}
          {boton("−fila", t.docQuitarFilaTabla, false, () => c().deleteRow().run())}
          {boton("−col", t.docQuitarColumna, false, () => c().deleteColumn().run())}
          {boton("✕▦", t.docQuitarTabla, false, () => c().deleteTable().run())}
        </>
      )}
    </div>
  );
}
