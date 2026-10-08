import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useEditor, EditorContent } from "@tiptap/react";
import Collaboration from "@tiptap/extension-collaboration";
import type { Socket } from "socket.io-client";
import { SERVER_URL } from "../socket";
import { useTextos } from "../i18n";
import { crearRenderer } from "./markdown";
import { extensionesDelDocumento } from "./esquema";
import { conVistas } from "./vistas";
import { ProveedorDocumento } from "./proveedor";

/**
 * El documento de la sala, vivo: lo que cambia cualquiera (el agente, otra
 * persona) aparece aquí en el momento, sin volver a pedirlo.
 *
 * Es un editor (TipTap) conectado al Y.Doc de la sala. El documento no es
 * markdown: es el mismo árbol de bloques que guarda el server, así que pintarlo
 * no convierte nada.
 *
 * Por ahora en solo lectura; editar es el paso siguiente.
 */
export function DocumentoView({ roomId, socket }: { roomId: string; socket: Socket }) {
  const { t } = useTextos();
  // Cada recarga del server (volver atrás) estrena proveedor y Y.Doc.
  const [intento, setIntento] = useState(0);
  const [listo, setListo] = useState(false);
  const [noHay, setNoHay] = useState(false);
  const [impresion, setImpresion] = useState<string | null>(null);

  const proveedor = useMemo(() => {
    void intento;
    return new ProveedorDocumento(socket, {
      editable: false,
      alSincronizar: () => setListo(true),
      alNoHaber: () => setNoHay(true),
      alRecargar: () => {
        setListo(false);
        setIntento((n) => n + 1);
      },
    });
  }, [socket, intento]);
  useEffect(() => () => proveedor.destruir(), [proveedor]);

  const urlImagen = useMemo(
    () => (nombre: string) => `${SERVER_URL}/rooms/${roomId}/documento/imagenes/${encodeURIComponent(nombre)}`,
    [roomId],
  );

  const editor = useEditor(
    {
      editable: false,
      extensions: [
        ...conVistas(extensionesDelDocumento({ soloLectura: true }), {
          objetos: proveedor.ydoc.getMap("objetos"),
          urlImagen,
          escribiendo: t.docEscribiendo,
        }),
        Collaboration.configure({ document: proveedor.ydoc, field: "contenido" }),
      ],
      editorProps: { attributes: { class: "doc-md" } },
    },
    [proveedor],
  );

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
