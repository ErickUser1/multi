import { io, type Socket } from "socket.io-client";

/**
 * A dónde le habla la Sala.
 *
 * Si la sirvió el propio server (build servido desde Fastify, que es como se
 * comparte por un túnel), el server ES este mismo origen. Solo en desarrollo —
 * cuando corre en el :5173 de Vite — hay que apuntar al :4000 aparte.
 *
 * Sin esto, una Sala abierta por un link de ngrok intentaría hablarle al
 * localhost:4000 DE QUIEN LA ABRE, que no existe: tu compa vería la sala en
 * blanco.
 */
const SERVER_URL =
  import.meta.env.VITE_SERVER_URL ??
  (import.meta.env.DEV ? "http://localhost:4000" : window.location.origin);

// ── Tipos de los mensajes que fluyen por el socket ──────────────────────────

export interface Member {
  socketId: string;
  name: string;
  color: string;
}

export interface ChatMessage {
  from: string;
  color: string;
  role: "human" | "agent" | "system";
  text: string;
  anchoredTo?: string;
}

/** Un agente de la sala, como jugador visible. */
export type AgentState = "idle" | "working" | "waiting" | "stuck";

export interface Agent {
  id: string;
  name: string;
  color: string;
  state: AgentState;
  task?: string;
  /** Si está esperando: a quién y por qué archivo (estado NORMAL, no alarma). */
  waitingFor?: { holder?: string; path: string };
}

/** Turno que quedó a medias por un crash del server. */
export interface OrphanTurn {
  id: string;
  agentId: string;
  task: string;
  startedAt: number;
}

/** Elemento del preview seleccionado (capturado por el inspector). */
export interface SelectedElement {
  selector: string;
  tag: string;
  text: string;
  path: string;
}

/** Cursor de otro miembro sobre el escenario. */
export interface CursorInfo {
  socketId: string;
  name: string;
  color: string;
  x: number;
  y: number;
}

/** Selección de otro miembro (broadcast). */
export interface SelectionInfo {
  socketId: string;
  name: string;
  color: string;
  element: SelectedElement | null;
}

export interface JoinedPayload {
  roomId: string;
  you: Member;
  members: Member[];
  previewUrl: string | null;
  /** El preview se está levantando ahora mismo (llegaste a media cuesta). */
  previewArrancando?: boolean;
  agents?: Agent[];
  /** Turnos que quedaron a medias por un crash; el humano decide qué hacer. */
  orphanTurns?: OrphanTurn[];
  /** El chat que ya existía en la sala (persistido). */
  messages?: ChatMessage[];
}

// ── API HTTP ────────────────────────────────────────────────────────────────

export async function createRoom(): Promise<string> {
  const res = await fetch(`${SERVER_URL}/rooms`, { method: "POST" });
  if (!res.ok) throw new Error("no se pudo crear la sala");
  const data = (await res.json()) as { id: string };
  return data.id;
}

// ── Socket ──────────────────────────────────────────────────────────────────

export function connectSocket(): Socket {
  return io(SERVER_URL, { transports: ["websocket"] });
}

export { SERVER_URL };
