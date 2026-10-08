import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEditor, EditorContent } from "@tiptap/react";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import type { Socket } from "socket.io-client";
import { SERVER_URL } from "../socket";
import { useTextos } from "../i18n";
import { crearRenderer } from "./markdown";
import { extensionesDelDocumento } from "./esquema";
import { conVistas } from "./vistas";
import { ProveedorDocumento, type EstadoDeGuardado } from "./proveedor";
import { MarcasDeAgentes, llaveMarcas, type DondeEscribe } from "./marcas";
import { Barra } from "./Barra";
import { EditorDeGrafica } from "./EditorDeGrafica";

/**
 * El documento de la sala, vivo y editable por todos a la vez.
 *
 * Es un editor (TipTap) conectado al Y.Doc de la sala: lo que escribe cada
 * persona y cada agente aparece en el momento en las pantallas de los demás,
 * con su cursor y su color. No hay "guardar": cada cambio viaja solo.
 */
export function DocumentoView({
  roomId,
  socket,
  yo,
}: {
  roomId: string;
  socket: Socket;
  yo: { name: string; color: string };
}) {
  const { t } = useTextos();
  // Cada recarga del server (volver atrás) estrena proveedor y Y.Doc.
  const [intento, setIntento] = useState(0);
  const [listo, setListo] = useState(false);
  const [noHay, setNoHay] = useState(false);
  const [guardado, setGuardado] = useState<EstadoDeGuardado>("guardado");
  const [impresion, setImpresion] = useState<string | null>(null);
  const [graficaAbierta, setGraficaAbierta] = useState<string | null>(null);
  const abrirGrafica = useRef<(ref: string) => void>(() => {});
  abrirGrafica.current = setGraficaAbierta;

  const proveedor = useMemo(() => {
    void intento;
    return new ProveedorDocumento(socket, {
      editable: true,
      alSincronizar: () => setListo(true),
      alNoHaber: () => setNoHay(true),
      alRecargar: () => {
        setListo(false);
        setGraficaAbierta(null);
        setIntento((n) => n + 1);
      },
      alGuardar: setGuardado,
    });
  }, [socket, intento]);
  useEffect(() => () => proveedor.destruir(), [proveedor]);

  const urlImagen = useMemo(
    () => (nombre: string) => `${SERVER_URL}/rooms/${roomId}/documento/imagenes/${encodeURIComponent(nombre)}`,
    [roomId],
  );

  const editor = useEditor(
    {
      editable: true,
      extensions: [
        ...conVistas(
          // Los ids de los bloques nuevos los pone el server (ver esquema.ts).
          extensionesDelDocumento(),
          {
            objetos: proveedor.ydoc.getMap("objetos"),
            urlImagen,
            escribiendo: t.docEscribiendo,
            alAbrirGrafica: (ref) => abrirGrafica.current(ref),
          },
        ),
        Collaboration.configure({ document: proveedor.ydoc, field: "contenido" }),
        CollaborationCaret.configure({ provider: { awareness: proveedor.awareness }, user: yo }),
        MarcasDeAgentes.configure({ fragmento: proveedor.ydoc.getXmlFragment("contenido") }),
      ],
      editorProps: { attributes: { class: "doc-md", spellcheck: "true" } },
    },
    [proveedor],
  );

  // Si cambia mi nombre o color (me renombré), mi cursor también.
  useEffect(() => {
    editor?.commands.updateUser?.(yo);
  }, [editor, yo.name, yo.color]); // eslint-disable-line react-hooks/exhaustive-deps

  // Dónde escribe cada agente.
  useEffect(() => {
    if (!editor) return;
    const enAgente = (d: DondeEscribe) => {
      if (!editor.isDestroyed) {
        editor.view.dispatch(editor.state.tr.setMeta(llaveMarcas, { ...d, etiqueta: `${d.agente} · ${t.docEscribiendo}` }));
      }
    };
    socket.on("doc:agente", enAgente);
    return () => {
      socket.off("doc:agente", enAgente);
    };
  }, [editor, socket, t]);

  const insertarGrafica = () => {
    if (!editor) return;
    const ref = Math.random().toString(36).slice(2, 10);
    const objetos = proveedor.ydoc.getMap("objetos");
    // Los datos y el bloque en la MISMA transacción: nadie ve un bloque sin datos.
    proveedor.ydoc.transact(() => {
      objetos.set(ref, {
        tipo: "grafica",
        fuente: JSON.stringify({
          tipo: "barras",
          titulo: "",
          etiquetas: ["A", "B", "C"],
          series: [{ nombre: "Serie 1", datos: [3, 5, 2] }],
        }),
      });
      // Después de lo seleccionado, nunca encima: si había una gráfica
      // seleccionada (la que acabas de editar), insertar no la reemplaza.
      const { to } = editor.state.selection;
      editor.chain().focus().insertContentAt(to, { type: "grafica", attrs: { ref } }).run();
    });
    setGraficaAbierta(ref);
  };

  // El PDF sale de la exportación en markdown, con el mismo renderer de
  // siempre: lo que se imprime no depende del editor.
  const imprimir = async () => {
    const r = await fetch(`${SERVER_URL}/rooms/${roomId}/documento`).catch(() => null);
    if (!r?.ok) return;
    const { markdown } = (await r.json()) as { markdown: string };
    setImpresion(crearRenderer(urlImagen)(markdown));
  };
  useEffect(() => {
    if (impresion === null) return;
    // Un cuadro después: que la copia ya esté en la página cuando se abra el diálogo.
    const id = requestAnimationFrame(() => {
      window.print();
      setImpresion(null);
    });
    return () => cancelAnimationFrame(id);
  }, [impresion]);

  if (noHay) return <div className="doc-estado">{t.docSinLeer}</div>;

  return (
    <div className="documento">
      <div className="doc-barra">
        {editor && listo && <Barra editor={editor} alInsertarGrafica={insertarGrafica} />}
        <span className={`doc-guardado ${guardado}`} aria-live="polite">
          {guardado === "guardado" ? t.docGuardado : guardado === "guardando" ? t.docGuardando : t.docSinConexion}
        </span>
        <button type="button" className="doc-boton" title={t.docTituloPdf} onClick={() => void imprimir()}>
          {t.docPdf}
        </button>
      </div>
      <div className="doc-scroll">
        {!listo && <div className="doc-estado">{t.docCargando}</div>}
        <article className="doc-hoja" hidden={!listo}>
          <EditorContent editor={editor} />
        </article>
      </div>
      {graficaAbierta && (
        <EditorDeGrafica objetos={proveedor.ydoc.getMap("objetos")} ref_={graficaAbierta} alCerrar={() => setGraficaAbierta(null)} />
      )}
      {/* Para imprimir va una copia fuera de la Sala: la sala recorta lo que no
          cabe en pantalla, y el PDF necesita el documento entero. En pantalla
          esta copia no se ve. */}
      {impresion !== null &&
        createPortal(
          <div className="doc-impresion">
            <article className="doc-hoja">
              <div className="doc-md" dangerouslySetInnerHTML={{ __html: impresion }} />
            </article>
          </div>,
          document.body,
        )}
    </div>
  );
}
