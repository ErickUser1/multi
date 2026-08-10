import type { Message } from "../agent/providers/types.js";

/**
 * Capa de persistencia de Multi.
 *
 * Abstracta a propósito: SQLite es el default (clonas el repo y corre, cero
 * setup — importante para open source), pero la interfaz deja la puerta abierta
 * a Postgres/Supabase cuando haya varios servidores.
 */

export interface StoredRoom {
  id: string;
  workspaceDir: string;
  createdAt: number;
  lastActiveAt: number;
}

export interface StoredMessage {
  roomId: string;
  author: string;
  color: string;
  role: "human" | "agent" | "system";
  text: string;
  anchoredTo?: string;
  /** Las imágenes que venían con el mensaje. Solo los datos para mostrarlas. */
  adjuntos?: { id: string; nombre: string; mediaType: string }[];
  createdAt: number;
}

export interface Storage {
  /** Crea el esquema si hace falta. */
  init(): Promise<void>;

  createRoom(room: StoredRoom): Promise<void>;
  getRoom(id: string): Promise<StoredRoom | null>;
  listRooms(): Promise<StoredRoom[]>;
  /** Marca actividad reciente (para saber qué salas siguen vivas). */
  touchRoom(id: string): Promise<void>;
  /**
   * Borra la sala y todo lo suyo: mensajes e historiales de agentes.
   *
   * Solo la parte de base de datos. El workspace en disco y el contenedor los
   * quita quien llama, porque no viven aquí.
   */
  deleteRoom(id: string): Promise<void>;

  appendMessage(msg: StoredMessage): Promise<void>;
  /** Los mensajes de una sala, en orden. */
  getMessages(roomId: string, limit?: number): Promise<StoredMessage[]>;

  /** Historial de conversación de un agente (para que continúe donde iba). */
  saveAgentHistory(roomId: string, agentId: string, messages: Message[]): Promise<void>;
  getAgentHistory(roomId: string, agentId: string): Promise<Message[]>;
  /**
   * Los agentes que han existido en una sala.
   *
   * Sin esto, al reiniciar el server la sala despierta con el registro vacío y
   * el contador en cero: el siguiente agente vuelve a llamarse "agente-1", el
   * menú de menciones sale vacío, y se pierde con quién venías conversando.
   */
  listAgentIds(roomId: string): Promise<string[]>;

  close(): Promise<void>;
}
