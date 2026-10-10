import { useEffect, useState } from "react";
import type { Agent, AgentState } from "./socket.js";

import steveBase from "./personajes/steve/base.webp";
import steveIdle from "./personajes/steve/idle.webp";
import steveWorking from "./personajes/steve/working.webp";
import steveWaiting from "./personajes/steve/waiting.webp";
import steveStuck from "./personajes/steve/stuck.webp";
import steveDone from "./personajes/steve/done.webp";
import steveCoding from "./personajes/steve/coding.webp";

/**
 * Los personajes de los agentes: cada agente de la sala tiene una cara, y la
 * cara cambia con lo que está haciendo.
 *
 * Se asignan por número y no al azar: agente-1 es siempre Steve, en todas las
 * salas y para todos los que miran. Si fuera al azar, dos personas en la misma
 * sala verían a personajes distintos hablando, y "dile a Steve" dejaría de
 * significar algo.
 *
 * Los agentes sin personaje todavía (del 2 en adelante, por ahora) se quedan
 * con el círculo de color de siempre.
 */

/** `base` es el que se queda quieto en el historial del chat; `done` dura un momento al terminar. */
type PoseDeEstado = "base" | AgentState | "done";
/**
 * Poses de lo que está haciendo dentro de su turno. Son opcionales: un
 * personaje que no la tenga se queda con la de trabajando.
 */
type PoseDeAccion = "coding";
export type Pose = PoseDeEstado | PoseDeAccion;

interface Personaje {
  nombre: string;
  poses: Record<PoseDeEstado, string> & Partial<Record<PoseDeAccion, string>>;
}

/** Qué acciones del agente (los `tipo` de su última línea de actividad) tienen pose propia. */
const POSE_DE_ACCION: Record<string, PoseDeAccion> = {
  escribir: "coding",
  editar: "coding",
  escribirDocumento: "coding",
};

const PERSONAJES: Personaje[] = [
  {
    nombre: "Steve",
    poses: {
      base: steveBase,
      idle: steveIdle,
      working: steveWorking,
      waiting: steveWaiting,
      stuck: steveStuck,
      done: steveDone,
      coding: steveCoding,
    },
  },
];

// Se piden todas de una vez: si la pose nueva se bajara al cambiar de estado,
// el avatar parpadearía vacío justo en el momento que se quiere ver.
for (const p of PERSONAJES) {
  for (const src of Object.values(p.poses)) new Image().src = src;
}

export function personajeDe(nombreDelAgente: string): Personaje | null {
  const m = /^agente-(\d+)$/.exec(nombreDelAgente);
  if (!m) return null;
  return PERSONAJES[Number(m[1]) - 1] ?? null;
}

/** Cuánto se queda festejando antes de dormirse. */
const FESTEJO_MS = 2500;

/**
 * La pose de un agente en vivo. Es su estado, salvo en dos casos: al terminar
 * festeja un momento entre "trabajando" y "dormido", que es lo que hace notar
 * que acabó sin tener que leer nada; y mientras trabaja, si lo último que hizo
 * tiene pose propia (escribir código), se ve haciendo eso.
 */
export function usePose(agent: Agent | undefined, accion?: string): Pose {
  const estado = agent?.state ?? "idle";
  const [anterior, setAnterior] = useState(estado);
  const [festejando, setFestejando] = useState(false);

  // El cambio se detecta durante el render y no en un efecto: con el efecto,
  // el primer cuadro después de terminar ya pintaba al agente dormido y el
  // festejo llegaba un instante tarde, como un parpadeo.
  if (anterior !== estado) {
    setAnterior(estado);
    setFestejando(estado === "idle" && anterior !== "idle");
  }

  useEffect(() => {
    if (!festejando) return;
    const t = setTimeout(() => setFestejando(false), FESTEJO_MS);
    return () => clearTimeout(t);
  }, [festejando]);

  if (festejando) return "done";
  if (estado === "working" && accion && agent) {
    const pose = POSE_DE_ACCION[accion];
    if (pose && personajeDe(agent.name)?.poses[pose]) return pose;
  }
  return estado;
}

/**
 * La carita de un agente: su personaje en la pose que toca, o el círculo de
 * color con "AI" si todavía no tiene personaje.
 */
export function AvatarDeAgente(props: {
  nombre: string;
  color: string;
  pose: Pose;
  titulo?: string;
  className?: string;
}) {
  const personaje = personajeDe(props.nombre);
  if (!personaje) {
    return (
      <div
        className={`av ${props.className ?? ""}`}
        style={{ background: props.color, color: "#3d2a12" }}
        title={props.titulo}
      >
        AI
      </div>
    );
  }
  return (
    <img
      className={`av av-personaje pose-${props.pose} ${props.className ?? ""}`}
      src={personaje.poses[props.pose] ?? personaje.poses.working}
      alt={personaje.nombre}
      title={props.titulo ?? personaje.nombre}
      draggable={false}
    />
  );
}

/** El mismo avatar, siguiendo el estado del agente en vivo. */
export function AvatarVivo(props: {
  agent: Agent | undefined;
  /** El `tipo` de su última acción, si la hay. */
  accion?: string;
  nombre: string;
  color: string;
  titulo?: string;
  className?: string;
}) {
  const pose = usePose(props.agent, props.accion);
  return (
    <AvatarDeAgente
      nombre={props.nombre}
      color={props.color}
      titulo={props.titulo}
      className={props.className}
      pose={pose}
    />
  );
}
