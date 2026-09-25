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
export interface OpcionDeMencion {
  name: string;
  hint: string;
  color: string;
  nuevo: boolean;
  ocupado: boolean;
}

/**
 * Lo que ofrece el menú para lo escrito después de la @, en orden.
 *
 * Aparte del componente porque la caja de escribir también lo necesita: es la
 * que recibe el teclado, y tiene que saber qué opción acepta un Tab o un Enter.
 */
export function opcionesDeMencion(agents: Agent[], query: string): OpcionDeMencion[] {
  const q = query.toLowerCase();

  const existentes = agents.map((a) => ({
    name: a.name,
    hint: hintDe(a),
    color: a.color,
    nuevo: false,
    ocupado: a.state !== "idle",
  }));

  return [
    ...existentes,
    {
      name: "agente",
      hint: "lanzar uno nuevo, en paralelo",
      color: "#ffc37a",
      nuevo: true,
      ocupado: false,
    },
  ].filter((o) => o.name.toLowerCase().startsWith(q));
}

export function MentionMenu(props: {
  opciones: OpcionDeMencion[];
  /** La que acepta un Tab o un Enter; las flechas la mueven. */
  seleccion: number;
  onPick: (name: string) => void;
}) {
  if (props.opciones.length === 0) return null;

  return (
    <div className="mention-menu" role="listbox">
      {props.opciones.map((o, i) => (
        <div
          key={o.name}
          role="option"
          aria-selected={i === props.seleccion}
          className={`mention-item ${o.nuevo ? "mention-nuevo" : ""} ${i === props.seleccion ? "mention-activo" : ""}`}
          onMouseDown={() => props.onPick(o.name)}
        >
          <span className="mention-name" style={{ color: o.color }}>
            @{o.name}
          </span>
          <span className="mention-hint">{o.hint}</span>
          {/* A los que trabajan SÍ se les puede hablar: el mensaje los detiene y
              atienden lo nuevo, con un solo gesto. Decía "interrumpir", que se
              leía como un botón que no existe; ahora describe lo que pasa. */}
          {o.ocupado && <span className="mention-tag">lo detiene</span>}
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
