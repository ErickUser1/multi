import { useEffect, useRef, useState } from "react";
import { MentionMenu, useMenciones } from "../MentionMenu";
import { useTextos } from "../i18n";
import type { Agent } from "../socket";

/** Un comentario tal como lo manda el server. */
export interface Comentario {
  id: string;
  hiloId: string;
  ancla: string | null;
  cita: string | null;
  autor: string;
  color: string;
  rol: "human" | "agent" | "system";
  texto: string;
  creado: number;
  resuelto: boolean;
}

export interface Hilo {
  raiz: Comentario;
  respuestas: Comentario[];
  /** Su texto ya no está en el documento (se borró). */
  sinTexto: boolean;
}

/**
 * Una caja para escribir un comentario, con el mismo menú de menciones del
 * chat: en una sala de varias personas, `@agente-1 …` le habla al agente.
 */
function Caja({
  agents,
  placeholder,
  alEnviar,
  alCancelar,
  enfocar,
}: {
  agents: Agent[];
  placeholder: string;
  alEnviar: (texto: string) => void;
  alCancelar?: () => void;
  enfocar?: boolean;
}) {
  const { t } = useTextos();
  const [texto, setTexto] = useState("");
  const menciones = useMenciones(agents);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (enfocar) ref.current?.focus();
  }, [enfocar]);
  const enviar = () => {
    if (!texto.trim()) return;
    alEnviar(texto.trim());
    setTexto("");
  };
  return (
    <div className="com-caja">
      {menciones.abierto && (
        <MentionMenu opciones={menciones.opciones} seleccion={menciones.sel} onPick={(n) => setTexto((v) => menciones.elegir(v, n))} />
      )}
      <textarea
        ref={ref}
        rows={2}
        value={texto}
        placeholder={placeholder}
        onChange={(e) => {
          setTexto(e.target.value);
          menciones.alCambiar(e.target.value);
        }}
        onKeyDown={(e) => {
          const delMenu = menciones.alTeclear(e);
          if (typeof delMenu === "string") {
            setTexto((v) => menciones.elegir(v, delMenu));
            return;
          }
          if (delMenu) return;
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            enviar();
          }
          if (e.key === "Escape") alCancelar?.();
        }}
      />
      <div className="com-caja-acciones">
        {alCancelar && (
          <button type="button" className="doc-boton" onClick={alCancelar}>
            {t.docCancelar}
          </button>
        )}
        <button type="button" className="doc-boton principal" disabled={!texto.trim()} onClick={enviar}>
          {t.docEnviar}
        </button>
      </div>
    </div>
  );
}

/**
 * Los hilos de comentarios del documento, en el orden en que aparecen en la
 * hoja. Un clic en un hilo resalta su texto; responder y resolver, aquí mismo.
 */
export function Comentarios({
  hilos,
  activo,
  borrador,
  agents,
  alActivar,
  alComentar,
  alCancelarBorrador,
  alResponder,
  alResolver,
}: {
  hilos: Hilo[];
  activo: string | null;
  borrador: { cita: string } | null;
  agents: Agent[];
  alActivar: (hilo: string) => void;
  alComentar: (texto: string) => void;
  alCancelarBorrador: () => void;
  alResponder: (hilo: string, texto: string) => void;
  alResolver: (hilo: string, resuelto: boolean) => void;
}) {
  const { t } = useTextos();
  const [verResueltos, setVerResueltos] = useState(false);
  const visibles = hilos.filter((h) => verResueltos || !h.raiz.resuelto);
  const resueltos = hilos.filter((h) => h.raiz.resuelto).length;
  const tarjetas = useRef(new Map<string, HTMLElement>());

  useEffect(() => {
    if (activo) tarjetas.current.get(activo)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activo]);

  return (
    <aside className="com-panel" aria-label={t.docComentarios}>
      <div className="com-cab">
        <strong>{t.docComentarios}</strong>
        {resueltos > 0 && (
          <button type="button" className="com-enlace" onClick={() => setVerResueltos((v) => !v)}>
            {verResueltos ? t.docOcultarResueltos : t.docVerResueltos(resueltos)}
          </button>
        )}
      </div>

      {borrador && (
        <div className="com-hilo activo nuevo">
          <blockquote className="com-cita">{borrador.cita}</blockquote>
          <Caja agents={agents} placeholder={t.docEscribeComentario} alEnviar={alComentar} alCancelar={alCancelarBorrador} enfocar />
        </div>
      )}

      {visibles.length === 0 && !borrador && <p className="com-vacio">{t.docSinComentarios}</p>}

      {visibles.map((h) => (
        <div
          key={h.raiz.id}
          ref={(el) => {
            if (el) tarjetas.current.set(h.raiz.id, el);
            else tarjetas.current.delete(h.raiz.id);
          }}
          className={`com-hilo ${activo === h.raiz.id ? "activo" : ""} ${h.raiz.resuelto ? "resuelto" : ""}`}
          onClick={() => alActivar(h.raiz.id)}
        >
          {h.raiz.cita && (
            <blockquote className={`com-cita ${h.sinTexto ? "borrada" : ""}`} title={h.sinTexto ? t.docTextoBorrado : undefined}>
              {h.raiz.cita}
            </blockquote>
          )}
          {h.sinTexto && <p className="com-aviso">{t.docTextoBorrado}</p>}
          {[h.raiz, ...h.respuestas].map((c) => (
            <div key={c.id} className={`com-mensaje ${c.rol}`}>
              {c.rol !== "system" && (
                <span className="com-autor" style={{ color: c.color }}>
                  {c.autor}
                </span>
              )}
              <span className="com-texto">{c.texto}</span>
            </div>
          ))}
          {activo === h.raiz.id && (
            <>
              {!h.raiz.resuelto && (
                <Caja agents={agents} placeholder={t.docResponder} alEnviar={(texto) => alResponder(h.raiz.id, texto)} />
              )}
              <div className="com-acciones">
                <button
                  type="button"
                  className="doc-boton"
                  onClick={(e) => {
                    e.stopPropagation();
                    alResolver(h.raiz.id, !h.raiz.resuelto);
                  }}
                >
                  {h.raiz.resuelto ? t.docReabrir : t.docResolver}
                </button>
              </div>
            </>
          )}
        </div>
      ))}
    </aside>
  );
}
