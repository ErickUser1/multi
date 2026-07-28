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
    ocupado: a.state !== "idle",
  }));

  const opciones = [
    ...existentes,
    {
      name: "agente",
      hint: "lanzar uno nuevo, en paralelo",
      color: "#ffc37a",
      nuevo: true,
      ocupado: false,
    },
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
          {/* A los que trabajan SÍ se les puede hablar: el mensaje los
              interrumpe y atienden lo nuevo. Se avisa para que no parezca
              que hay que esperar. */}
          {o.ocupado && <span className="mention-tag">interrumpir</span>}
        </div>
      ))}
    </div>
  );
}

/** Qué está haciendo, en términos de si le puedes hablar ahora. */
function hintDe(a: Agent): string {
  if (a.state === "idle") return a.task ? `libre · antes: ${truncate(a.task, 22)}` : "libre";
  if (a.state === "waiting") return "esperando su turno";
  if (a.state === "stuck") return "atorado";
  return a.task ? `trabajando en ${truncate(a.task, 22)}` : "trabajando";
}

function truncate(s: string, n = 34): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > n ? `${clean.slice(0, n)}…` : clean;
}
