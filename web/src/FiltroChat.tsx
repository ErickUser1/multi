import { useEffect, useRef, useState } from "react";
import { useTextos } from "./i18n.js";
import type { Agent, Member } from "./socket.js";

/**
 * El botón que abre el filtro del chat.
 *
 * Existe además de los avatares clicables de arriba, y no en vez de ellos: los
 * avatares son un atajo para quien ya sabe que se puede filtrar, pero nada en
 * ellos lo anuncia. Con cinco personas hablando, el filtro no sirve de nada si
 * hay que descubrirlo por accidente.
 *
 * Y escala mejor: con tres agentes y cinco personas la fila de avatares se
 * llena, mientras que una lista con nombres se lee igual de bien.
 */
export function FiltroChat(props: {
  members: Member[];
  agents: Agent[];
  filtro: Set<string>;
  onAlternar: (nombre: string) => void;
  onLimpiar: () => void;
}) {
  const { t } = useTextos();
  const [abierto, setAbierto] = useState(false);
  const caja = useRef<HTMLDivElement | null>(null);

  // Cerrar al clicar fuera y con Escape: un desplegable que se queda abierto
  // tapa el chat, que es justo lo que se vino a leer.
  useEffect(() => {
    if (!abierto) return;
    const fuera = (e: MouseEvent) => {
      if (caja.current && !caja.current.contains(e.target as Node)) setAbierto(false);
    };
    const tecla = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAbierto(false);
    };
    document.addEventListener("mousedown", fuera);
    document.addEventListener("keydown", tecla);
    return () => {
      document.removeEventListener("mousedown", fuera);
      document.removeEventListener("keydown", tecla);
    };
  }, [abierto]);

  // Sin nadie en la sala no hay nada que filtrar.
  if (props.members.length === 0 && props.agents.length === 0) return null;

  const activos = props.filtro.size;

  return (
    <div className="filtro-caja" ref={caja}>
      <button
        type="button"
        className={`filtro-abrir ${activos > 0 ? "on" : ""}`}
        onClick={() => setAbierto((v) => !v)}
        title={t.filtrarChat}
      >
        {activos > 0 ? t.filtrandoA(activos) : t.filtrarChat}
      </button>

      {abierto && (
        <div className="filtro-menu">
          {props.members.map((m) => (
            <Fila
              key={m.socketId}
              nombre={m.name}
              color={m.color}
              marcado={props.filtro.has(m.name)}
              onClick={() => props.onAlternar(m.name)}
            />
          ))}
          {props.agents.map((a) => (
            <Fila
              key={a.id}
              nombre={a.name}
              color={a.color}
              agente
              marcado={props.filtro.has(a.name)}
              onClick={() => props.onAlternar(a.name)}
            />
          ))}
          {activos > 0 && (
            <button
              type="button"
              className="filtro-limpiar"
              onClick={() => {
                props.onLimpiar();
                setAbierto(false);
              }}
            >
              {t.verTodo}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Fila(props: {
  nombre: string;
  color: string;
  agente?: boolean;
  marcado: boolean;
  onClick: () => void;
}) {
  const { t } = useTextos();
  return (
    <button
      type="button"
      className={`filtro-fila ${props.marcado ? "on" : ""}`}
      onClick={props.onClick}
    >
      <span className="filtro-punto" style={{ background: props.color }} />
      <span className="filtro-nombre" style={{ color: props.color }}>
        {props.nombre}
      </span>
      {props.agente && <span className="tag-ai">{t.tagAgente}</span>}
      <span className="filtro-check">{props.marcado ? "✓" : ""}</span>
    </button>
  );
}
