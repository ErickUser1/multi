/**
 * Las API keys de los miembros de una sala.
 *
 * Cada quien trae la suya y paga lo que pide. Sin esto, el server corre con UNA
 * key (la del `.env`) y quien invitaste te gasta el saldo — que es exactamente
 * lo que pasa cuando abres una sala a un compa.
 *
 * REGLAS, y son el punto de este módulo:
 * - Vive SOLO en memoria. Al reiniciar el server se pierde y hay que pegarla de
 *   nuevo. A cambio, Multi nunca almacena el secreto de nadie: es una
 *   responsabilidad que un proyecto que cualquiera puede hospedar no debe tener.
 * - NUNCA se emite a la sala, NUNCA se escribe en el workspace, NUNCA entra al
 *   contenedor. La key es de quien MANDA; el `.env` del proyecto es del
 *   PROYECTO. Son dos capas distintas y no se cruzan.
 * - Al desconectarse, se borra.
 */

/** socketId → la key de esa persona. */
const keys = new Map<string, string>();

/** Formato de las keys de Anthropic. Atajar aquí un typo evita un 401 confuso. */
const ANTHROPIC_KEY_RE = /^sk-ant-[A-Za-z0-9_\-]{20,}$/;

export type KeyResult = { ok: true } | { ok: false; message: string };

export function setKey(socketId: string, raw: unknown): KeyResult {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, message: "la key llegó vacía" };
  }
  const key = raw.trim();
  if (!ANTHROPIC_KEY_RE.test(key)) {
    return {
      ok: false,
      message: "eso no parece una key de Anthropic (empiezan con sk-ant-)",
    };
  }
  keys.set(socketId, key);
  return { ok: true };
}

export function getKey(socketId: string): string | undefined {
  return keys.get(socketId);
}

export function hasKey(socketId: string): boolean {
  return keys.has(socketId);
}

export function clearKey(socketId: string): void {
  keys.delete(socketId);
}
