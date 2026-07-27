import { useEffect, useState } from "react";
import { SERVER_URL } from "./socket.js";

/**
 * La línea de tiempo de la sala: cada punto es un turno de agente.
 *
 * Tres niveles de profundidad (el código no es el centro, pero está accesible):
 *   la barra (siempre visible) → el detalle del punto → el diff (opt-in)
 */

export interface HistoryEntry {
  hash: string;
  author: string;
  date: string;
  message: string;
  bookmark?: string;
  files: string[];
  task?: string;
}

export function Historial(props: {
  roomId: string;
  /** Se dispara al pedir volver a un punto (total o de un archivo). */
  onRevert: (hash: string, file?: string) => void;
  onBookmark: (hash: string, label: string | null) => void;
  /** Señal para recargar (cambió el historial). */
  version: number;
}) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [selected, setSelected] = useState<HistoryEntry | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ hash: string; file?: string } | null>(null);

  useEffect(() => {
    fetch(`${SERVER_URL}/rooms/${props.roomId}/history`)
      .then((r) => r.json())
      .then((d) => setEntries(d.entries ?? []))
      .catch(() => setEntries([]));
  }, [props.roomId, props.version]);

  // Del más viejo al más nuevo, para que la barra avance hacia la derecha.
  const puntos = [...entries].reverse();

  const verDiff = async (hash: string) => {
    setDiff("cargando…");
    const r = await fetch(`${SERVER_URL}/rooms/${props.roomId}/diff/${hash}`).then((x) => x.json());
    setDiff(r.patch || "(sin cambios)");
  };

  return (
    <div className="historial">
      <span className="hist-label">Historial</span>

      <div className="hist-barra">
        {puntos.length === 0 && <span className="hist-vacio">aún no hay cambios guardados</span>}
        {puntos.map((e) => (
          <button
            key={e.hash}
            className={`hist-punto ${e.bookmark ? "marcado" : ""} ${selected?.hash === e.hash ? "activo" : ""}`}
            title={`${e.author} · ${e.task ?? e.message} · ${fecha(e.date)}`}
            onClick={() => {
              setSelected(selected?.hash === e.hash ? null : e);
              setDiff(null);
            }}
          >
            {e.bookmark ? "★" : "●"}
          </button>
        ))}
        <span className="hist-ahora" title="el estado actual">
          ahora
        </span>
      </div>

      {/* Detalle del punto seleccionado */}
      {selected && (
        <div className="hist-detalle">
          <div className="hist-det-cab">
            <span className="hist-det-autor">{selected.author}</span>
            <span className="hist-det-fecha">{fecha(selected.date)}</span>
          </div>
          {/* Lo que se pidió — "por qué pasó este cambio" */}
          {selected.task && <div className="hist-det-task">"{truncate(selected.task, 90)}"</div>}
          {selected.files.length > 0 && (
            <div className="hist-det-files">
              {selected.files.slice(0, 6).map((f) => (
                <span key={f} className="hist-file" onClick={() => setConfirming({ hash: selected.hash, file: f })} title={`regresar solo ${f}`}>
                  {f}
                </span>
              ))}
              {selected.files.length > 6 && <span className="hist-file">+{selected.files.length - 6}</span>}
            </div>
          )}

          <div className="hist-acciones">
            <button className="hist-btn" onClick={() => verDiff(selected.hash)}>
              Ver cambios
            </button>
            <button className="hist-btn" onClick={() => setConfirming({ hash: selected.hash })}>
              Regresar aquí
            </button>
            <button
              className="hist-btn"
              onClick={() =>
                props.onBookmark(
                  selected.hash,
                  selected.bookmark ? null : prompt("¿cómo la llamas?", "versión que funcionaba") || null,
                )
              }
            >
              {selected.bookmark ? "★ quitar marca" : "☆ marcar"}
            </button>
          </div>

          {diff !== null && (
            <pre className="hist-diff">
              {diff.split("\n").map((l, i) => (
                <div key={i} className={l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : ""}>
                  {l}
                </div>
              ))}
            </pre>
          )}
        </div>
      )}

      {/* Confirmación antes de revertir (evita accidentes) */}
      {confirming && (
        <div className="hist-confirm">
          <div className="hist-confirm-text">
            {confirming.file
              ? `¿Regresar solo ${confirming.file} a este estado?`
              : "¿Regresar TODO el proyecto a este estado?"}
            <div className="hist-confirm-nota">
              No se borra nada: se guarda como un cambio nuevo y lo posterior sigue en el historial.
              {" "}El código vuelve, pero los datos de la base NO.
            </div>
          </div>
          <div className="hist-confirm-acciones">
            <button
              className="hist-btn primario"
              onClick={() => {
                props.onRevert(confirming.hash, confirming.file);
                setConfirming(null);
                setSelected(null);
              }}
            >
              Sí, regresar
            </button>
            <button className="hist-btn" onClick={() => setConfirming(null)}>
              Cancelar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function fecha(iso: string): string {
  const d = new Date(iso);
  const min = Math.round((Date.now() - d.getTime()) / 60000);
  if (min < 1) return "hace un momento";
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  return d.toLocaleDateString();
}

function truncate(s: string, n: number): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > n ? `${clean.slice(0, n)}…` : clean;
}
