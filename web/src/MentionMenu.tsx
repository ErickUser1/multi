import type { Agent } from "./socket.js";

/**
 * Menú de menciones: al escribir "@" muestra a quién puedes dirigirte.
 *
 * Muestra TODOS los agentes de la sala, no solo los que están trabajando: un
 * agente que terminó sigue siendo con quien ya hablaste, y tiene su contexto de
 * la conversación. Ocultarlo obligaba a crear uno nuevo sin querer, y ese nuevo
 * arranca sin saber nada de lo anterior.
 *
 * "@agente" (crear uno nuevo) va al FINAL: lo normal es seguirle hablando a
 * quien ya está en la sala; abrir otro es para trabajo en paralelo.
 */
export function MentionMenu(props: {
  agents: Agent[];
  /** Lo escrito después de la @ (para filtrar). */
  query: string;
  onPick: (name: string) => void;
}) {
  const q = props.query.toLowerCase();

  const existentes = props.agents.map((a) => ({
    name: a.name,
    hint: hintDe(a),
    color: a.color,
    nuevo: false,
  }));

  const opciones = [
    ...existentes,
    { name: "agente", hint: "lanzar otro en paralelo", color: "#ffc37a", nuevo: true },
  ].filter((o) => o.name.toLowerCase().startsWith(q));

  if (opciones.length === 0) return null;

  return (
    <div className="mention-menu">
      {opciones.map((o) => (
        <div
          key={o.name}
          className={`mention-item ${o.nuevo ? "mention-nuevo" : ""}`}
          onMouseDown={() => props.onPick(o.name)}
        >
          <span className="mention-name" style={{ color: o.color }}>
            @{o.name}
          </span>
          <span className="mention-hint">{o.hint}</span>
        </div>
      ))}
    </div>
  );
}

/** Qué está haciendo, en términos de si le puedes hablar ahora. */
function hintDe(a: Agent): string {
  if (a.state === "idle") return a.task ? `libre · antes: ${truncate(a.task, 24)}` : "libre";
  if (a.state === "waiting") return "esperando su turno";
  if (a.state === "stuck") return "atorado";
  return a.task ? truncate(a.task) : "trabajando";
}

function truncate(s: string, n = 34): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > n ? `${clean.slice(0, n)}…` : clean;
}
