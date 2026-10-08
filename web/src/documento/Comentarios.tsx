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

function hora(ms: number): string {
  const d = new Date(ms);
  const hoy = new Date();
  const mismaFecha = d.toDateString() === hoy.toDateString();
  return mismaFecha
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * La caja para escribir, con el mismo menú de menciones del chat. A quién le
 * habla lo decide la regla del chat: en una sala de una persona, al agente; en
 * multijugador, al agente solo si lo mencionan con @.
 */
function Caja({
  agents,
  placeholder,
  alEnviar,
  alEscapar,
}: {
  agents: Agent[];
  placeholder: string;
  alEnviar: (texto: string) => void;
  alEscapar: () => void;
}) {
  const { t } = useTextos();
  const [texto, setTexto] = useState("");
  const menciones = useMenciones(agents);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
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
        rows={1}
        value={texto}
        placeholder={placeholder}
        onChange={(e) => {
          setTexto(e.target.value);
          menciones.alCambiar(e.target.value);
          // Crece con lo escrito, hasta un tope.
          e.target.style.height = "auto";
          e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
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
          if (e.key === "Escape") alEscapar();
        }}
      />
      <div className="com-caja-pie">
        <button type="button" className="com-enviar" disabled={!texto.trim()} onClick={enviar} aria-label={t.docEnviar} title={t.docEnviar}>
          ↑
        </button>
      </div>
    </div>
  );
}

function Mensaje({ c }: { c: Comentario }) {
  if (c.rol === "system") return <div className="com-mensaje system">{c.texto}</div>;
  return (
    <div className="com-mensaje">
      <div className="com-mensaje-cab">
        <span className="com-avatar" style={{ background: c.color }}>
          {c.rol === "agent" ? "AI" : (c.autor[0] ?? "?").toUpperCase()}
        </span>
        <span className="com-autor">{c.autor}</span>
        <span className="com-hora">{hora(c.creado)}</span>
      </div>
      <div className="com-texto">{c.texto}</div>
    </div>
  );
}

/**
 * Un hilo de comentarios, flotando junto a su texto (como en Google Docs o
 * Claude): se abre al tocar el resaltado, se cierra con la × o tocando fuera,
 * y ✓ lo resuelve. Las respuestas de en medio se pliegan: se ve el primero y
 * el último, que es lo que importa para seguir la conversación.
 *
 * Sin `hilo` es un comentario nuevo sobre lo seleccionado.
 */
export function TarjetaComentario({
  hilo,
  pos,
  agents,
  soloYo,
  alCerrar,
  alEnviar,
  alResolver,
}: {
  hilo: Hilo | null;
  pos: { top: number; left: number; ancho: number };
  agents: Agent[];
  /** Sala de una persona: lo que se escribe le habla al agente, sin @. */
  soloYo: boolean;
  alCerrar: () => void;
  alEnviar: (texto: string) => void;
  alResolver?: (resuelto: boolean) => void;
}) {
  const { t } = useTextos();
  const [verTodas, setVerTodas] = useState(false);
  const respuestas = hilo?.respuestas ?? [];
  const plegadas = !verTodas && respuestas.length > 1 ? respuestas.length - 1 : 0;
  const visibles = plegadas ? respuestas.slice(-1) : respuestas;

  return (
    <div
      className="com-tarjeta"
      role="dialog"
      aria-label={t.docComentarios}
      style={{ top: pos.top, left: pos.left, width: pos.ancho }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="com-tarjeta-acciones">
        {hilo && alResolver && (
          <button
            type="button"
            className="com-icono"
            title={hilo.raiz.resuelto ? t.docReabrir : t.docResolver}
            aria-label={hilo.raiz.resuelto ? t.docReabrir : t.docResolver}
            onClick={() => alResolver(!hilo.raiz.resuelto)}
          >
            {hilo.raiz.resuelto ? "↺" : "✓"}
          </button>
        )}
        <button type="button" className="com-icono" title={t.docCerrar} aria-label={t.docCerrar} onClick={alCerrar}>
          ×
        </button>
      </div>

      {hilo ? (
        <>
          {hilo.sinTexto && hilo.raiz.cita && (
            <p className="com-aviso">
              {t.docTextoBorrado} <span className="com-cita-borrada">«{hilo.raiz.cita}»</span>
            </p>
          )}
          <Mensaje c={hilo.raiz} />
          {plegadas > 0 && (
            <button type="button" className="com-plegadas" onClick={() => setVerTodas(true)}>
              {t.docMostrarRespuestas(plegadas)}
            </button>
          )}
          {visibles.map((c) => (
            <Mensaje key={c.id} c={c} />
          ))}
          {!hilo.raiz.resuelto && (
            <Caja agents={agents} placeholder={soloYo ? t.docResponderSolo : t.docResponderMulti} alEnviar={alEnviar} alEscapar={alCerrar} />
          )}
        </>
      ) : (
        <Caja agents={agents} placeholder={soloYo ? t.docComentarSolo : t.docComentarMulti} alEnviar={alEnviar} alEscapar={alCerrar} />
      )}
    </div>
  );
}
