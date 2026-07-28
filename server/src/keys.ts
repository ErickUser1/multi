import { PERFILES, esProviderId, type ProviderId } from "./agent/providers/profiles.js";

/**
 * Las credenciales de los miembros de una sala.
 *
 * Cada quien trae la suya y paga lo que pide. Sin esto, el server corre con UNA
 * key (la del `.env`) y quien invitaste te gasta el saldo — que es exactamente
 * lo que pasa cuando abres una sala a un compa.
 *
 * Y cada quien trae SU proveedor: uno puede estar con Claude, otro con un modelo
 * gratis de OpenRouter, otro con Ollama en su máquina. En un proyecto que
 * cualquiera puede correr, obligar a un solo proveedor es obligar a un gasto.
 *
 * REGLAS, y son el punto de este módulo:
 * - Vive SOLO en memoria. Al reiniciar el server se pierde. A cambio, Multi
 *   nunca almacena el secreto de nadie: es una responsabilidad que un proyecto
 *   que cualquiera puede hospedar no debe tener.
 * - NUNCA se emite a la sala, NUNCA se escribe en el workspace, NUNCA entra al
 *   contenedor. La key es de quien MANDA; el `.env` del proyecto es del
 *   PROYECTO. Son dos capas distintas y no se cruzan.
 * - Al desconectarse, se borra.
 */

export interface Credencial {
  provider: ProviderId;
  apiKey: string;
  /** Modelo elegido; si falta, el sugerido del perfil. */
  model?: string;
}

const creds = new Map<string, Credencial>();

/**
 * Formatos conocidos de key. Atajar aquí un typo evita un 401 confuso a los 30
 * segundos. Los que no tienen formato fijo (Ollama, algunos compatibles) solo
 * exigen que no venga vacío.
 */
const FORMATOS: Partial<Record<ProviderId, RegExp>> = {
  anthropic: /^sk-ant-[A-Za-z0-9_\-]{20,}$/,
  openrouter: /^sk-or-v1-[A-Za-z0-9_\-]{20,}$/,
  openai: /^sk-[A-Za-z0-9_\-]{20,}$/,
  groq: /^gsk_[A-Za-z0-9_\-]{20,}$/,
};

export type KeyResult = { ok: true } | { ok: false; message: string };

export function setCredential(socketId: string, payload: unknown): KeyResult {
  const p = (payload ?? {}) as Record<string, unknown>;

  const provider = p.provider ?? "anthropic";
  if (!esProviderId(provider)) {
    return { ok: false, message: `no conozco el proveedor "${String(provider)}"` };
  }

  const raw = p.key;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, message: "la key llegó vacía" };
  }
  const apiKey = raw.trim();

  const formato = FORMATOS[provider];
  if (formato && !formato.test(apiKey)) {
    return {
      ok: false,
      message: `esa no parece una key de ${PERFILES[provider].label} (empiezan con ${PERFILES[provider].keyHint})`,
    };
  }

  const model = typeof p.model === "string" && p.model.trim() ? p.model.trim() : undefined;
  creds.set(socketId, { provider, apiKey, model });
  return { ok: true };
}

export function getCredential(socketId: string): Credencial | undefined {
  return creds.get(socketId);
}

export function clearCredential(socketId: string): void {
  creds.delete(socketId);
}
