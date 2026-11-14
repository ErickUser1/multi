import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { PermisosDeSala, Rol } from "../storage/types.js";

/**
 * Quién es dueño, editor o lector en una sala. Funciones puras: el server las
 * llama en cada `join` y en cada ruta que cambia algo, y la demo las prueba sin
 * levantar nada.
 *
 * Cómo se sabe quién es el dueño: al crear la sala el server genera una llave
 * secreta, guarda solo su hash y le devuelve la llave UNA vez al navegador que
 * la creó (la guarda en localStorage). Si además tenía sesión con Google, se
 * guarda su cuenta, y así es dueño también desde otra compu.
 *
 * El `clienteId` del navegador NO sirve para eso: cualquiera lo puede inventar.
 * Por eso solo vale para los roles que el dueño da a mano (y esos se los da a
 * alguien que ya estaba en la sala, no a un id adivinado).
 */

/** Una llave nueva: 32 bytes al azar, en base64url. */
export function nuevaLlave(): string {
  return randomBytes(32).toString("base64url");
}

/** El código del link para editar. Más corto: va en una URL que se comparte. */
export function nuevoTokenEditar(): string {
  return randomBytes(12).toString("base64url");
}

export function hashLlave(llave: string): string {
  return createHash("sha256").update(llave).digest("hex");
}

/** Compara sin filtrar por tiempo cuántos caracteres coincidieron. */
function igualSeguro(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface Identidad {
  usuarioId?: string | null;
  clienteId?: string | null;
  llave?: string | null;
  tokenEditar?: string | null;
}

const texto = (v: unknown): string | null => (typeof v === "string" && v.length > 0 && v.length < 300 ? v : null);

/** Limpia lo que llega del navegador: solo strings razonables. */
export function identidadDe(crudo: {
  usuarioId?: unknown;
  clienteId?: unknown;
  llave?: unknown;
  tokenEditar?: unknown;
}): Identidad {
  return {
    usuarioId: texto(crudo.usuarioId),
    clienteId: texto(crudo.clienteId),
    llave: texto(crudo.llave),
    tokenEditar: texto(crudo.tokenEditar),
  };
}

/** Si esta identidad es la del dueño. */
export function esDueno(p: PermisosDeSala, quien: Identidad): boolean {
  if (!p.duenoLlave) return false;
  if (quien.llave && igualSeguro(hashLlave(quien.llave), p.duenoLlave)) return true;
  return !!p.duenoUsuario && !!quien.usuarioId && quien.usuarioId === p.duenoUsuario;
}

/**
 * El rol, en este orden:
 * 1. Sala sin dueño (las de antes): todos editan, como siempre.
 * 2. La llave o la cuenta del dueño: dueño.
 *    Con los roles apagados, aquí acaba: todos los demás editan.
 * 3. Lo que el dueño le dio a esa cuenta o a ese navegador.
 * 4. El link para editar: editor.
 * 5. Si no, lo que da el link normal.
 */
export function rolEnSala(p: PermisosDeSala, quien: Identidad): Rol {
  if (!p.duenoLlave) return "editor";
  if (esDueno(p, quien)) return "dueno";
  if (!p.activos) return "editor";
  if (quien.usuarioId && p.roles[`u:${quien.usuarioId}`]) return p.roles[`u:${quien.usuarioId}`];
  if (quien.clienteId && p.roles[`c:${quien.clienteId}`]) return p.roles[`c:${quien.clienteId}`];
  if (quien.tokenEditar && p.tokenEditar && igualSeguro(quien.tokenEditar, p.tokenEditar)) return "editor";
  return p.acceso === "ver" ? "lector" : "editor";
}

export function puedeEditar(rol: Rol): boolean {
  return rol !== "lector";
}

/** Con qué clave se guarda el rol que el dueño le da a alguien: su cuenta si tiene. */
export function claveDePersona(quien: { usuarioId?: string | null; clienteId?: string | null }): string | null {
  if (quien.usuarioId) return `u:${quien.usuarioId}`;
  if (quien.clienteId) return `c:${quien.clienteId}`;
  return null;
}
