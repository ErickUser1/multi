import type { Agent } from "./socket.js";

/**
 * Menú de menciones: al escribir "@" muestra a quién puedes dirigirte.
 * Sin esto, el usuario tiene que adivinar los nombres de los agentes.
 *
 * Siempre ofrece "@agente" (agente NUEVO) además de los existentes, porque esa
 * es la forma de lanzar trabajo en paralelo.
 */
export function MentionMenu(props: {
  agents: Agent[];
  /** Lo escrito después de la @ (para filtrar). */
  query: string;
  onPick: (name: string) => void;
}) {
  const q = props.query.toLowerCase();

  const opciones = [
    { name: "agente", hint: "lanzar un agente nuevo", color: "#ffc37a" },
    ...props.agents
      .filter((a) => a.state !== "idle")
      .map((a) => ({
        name: a.name,
        hint: a.task ? truncate(a.task) : a.state,
        color: a.color,
      })),
  ].filter((o) => o.name.toLowerCase().startsWith(q));

  if (opciones.length === 0) return null;

  return (
    <div className="mention-menu">
      {opciones.map((o) => (
        <div key={o.name} className="mention-item" onMouseDown={() => props.onPick(o.name)}>
          <span className="mention-name" style={{ color: o.color }}>
            @{o.name}
          </span>
          <span className="mention-hint">{o.hint}</span>
        </div>
      ))}
    </div>
  );
}

function truncate(s: string, n = 34): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > n ? `${clean.slice(0, n)}…` : clean;
}
