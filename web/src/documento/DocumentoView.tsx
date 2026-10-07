import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SERVER_URL } from "../socket";
import { useTextos } from "../i18n";
import { crearRenderer } from "./markdown";

interface Seccion {
  id: string;
  archivo: string;
  markdown: string;
  /** Qué va a ir aquí mientras nadie la escribe; null si ya tiene contenido. */
  pendiente: string | null;
}

interface Documento {
  titulo: string;
  secciones: Seccion[];
}

/**
 * El documento de la sala, pintado por Multi y no por un proyecto en el iframe.
 *
 * Por eso abre al instante (no hay dev server que levantar) y por eso, más
 * adelante, los comentarios se pueden anclar a una frase: aquí sí se sabe qué
 * hay en cada línea.
 *
 * `version` lo sube la Sala cada vez que algo pudo cambiar el documento (un
 * archivo bajo documento/, un turno que cerró, volver atrás en el historial):
 * es la señal para volver a pedirlo.
 */
export function DocumentoView({ roomId, version }: { roomId: string; version: number }) {
  const { t } = useTextos();
  const [doc, setDoc] = useState<Documento | null>(null);
  const [error, setError] = useState(false);
  const pidiendo = useRef(0);

  useEffect(() => {
    const yo = ++pidiendo.current;
    // Varios file:changed seguidos (el esqueleto son varios archivos) se
    // juntan en una sola petición.
    const espera = setTimeout(() => {
      fetch(`${SERVER_URL}/rooms/${roomId}/documento`)
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then((d: Documento) => {
          // Solo la respuesta más reciente pinta: una lenta no pisa a una nueva.
          if (yo !== pidiendo.current) return;
          setDoc(d);
          setError(false);
        })
        .catch(() => {
          if (yo === pidiendo.current) setError(true);
        });
    }, 120);
    return () => clearTimeout(espera);
  }, [roomId, version]);

  const render = useMemo(
    () =>
      crearRenderer((nombre) => `${SERVER_URL}/rooms/${roomId}/documento/imagenes/${encodeURIComponent(nombre)}`),
    [roomId],
  );

  if (!doc) {
    return <div className="doc-estado">{error ? t.docSinLeer : t.docCargando}</div>;
  }

  const hoja = <Hoja doc={doc} render={render} escribiendo={t.docEscribiendo} />;

  return (
    <div className="documento">
      <div className="doc-barra">
        <button
          type="button"
          className="doc-boton"
          title={t.docTituloPdf}
          onClick={() => window.print()}
        >
          {t.docPdf}
        </button>
      </div>
      <div className="doc-scroll">{hoja}</div>
      {/* Para imprimir va una copia fuera de la Sala: la sala recorta lo que no
          cabe en pantalla, y el PDF necesita el documento entero, página tras
          página. En pantalla esta copia no se ve. */}
      {createPortal(<div className="doc-impresion">{hoja}</div>, document.body)}
    </div>
  );
}

function Hoja({
  doc,
  render,
  escribiendo,
}: {
  doc: Documento;
  render: (md: string) => string;
  escribiendo: string;
}) {
  return (
    <article className="doc-hoja">
      {doc.titulo && <h1 className="doc-titulo">{doc.titulo}</h1>}
      {doc.secciones.map((s) => (
        <section key={s.id} className="doc-seccion" data-seccion={s.id}>
          {s.markdown && <div className="doc-md" dangerouslySetInnerHTML={{ __html: render(s.markdown) }} />}
          {s.pendiente !== null && (
            <div className="doc-pendiente" aria-busy="true">
              <span className="doc-pendiente-que">{s.pendiente || escribiendo}</span>
              <span className="doc-linea" />
              <span className="doc-linea" />
              <span className="doc-linea corta" />
            </div>
          )}
        </section>
      ))}
    </article>
  );
}
