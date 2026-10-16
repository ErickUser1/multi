import { useState } from "react";
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

/**
 * El manejo de teclado y de texto del menú de menciones, para cualquier caja:
 * la del chat y la de los comentarios del documento usan el mismo. "@" al
 * inicio de una palabra abre el menú; flechas lo mueven; Tab o Enter aceptan.
 */
export function useMenciones(agents: Agent[]) {
  const [mention, setMention] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const opciones = mention !== null ? opcionesDeMencion(agents, mention) : [];

  /** Llamar con cada cambio del texto. */
  const alCambiar = (valor: string) => {
    const m = valor.match(/(?:^|\s)@([a-z0-9-]*)$/i);
    setMention(m ? m[1] : null);
    // Lo escrito cambia qué se ofrece: se vuelve a la primera opción.
    setSel(0);
  };

  /** El texto con la mención escogida ya puesta. */
  const elegir = (valor: string, nombre: string): string => {
    setMention(null);
    return valor.replace(/(?:^|\s)@([a-z0-9-]*)$/i, (full) => `${full.startsWith(" ") ? " " : ""}@${nombre} `);
  };

  /**
   * Con el menú abierto, el teclado es del menú. Devuelve el nombre escogido
   * (Tab/Enter), true si el evento ya se usó (flechas), o false si no es suyo.
   */
  const alTeclear = (e: { key: string; shiftKey: boolean; preventDefault: () => void }): string | boolean => {
    if (e.key === "Escape") {
      setMention(null);
      return false;
    }
    if (mention === null || opciones.length === 0) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = opciones.length;
      setSel((i) => (i + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
      return true;
    }
    if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
      e.preventDefault();
      return opciones[Math.min(sel, opciones.length - 1)].name;
    }
    return false;
  };

  return { abierto: mention !== null, opciones, sel, alCambiar, elegir, alTeclear, cerrar: () => setMention(null) };
}
