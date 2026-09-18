import { resolve, relative, isAbsolute } from "node:path";
import type { ToolSpec } from "../providers/types.js";

/**
 * Contexto que reciben las tools: dónde viven (el workspace de la sala) y
 * un canal para emitir eventos (→ socket para el preview/presencia en vivo).
 */
export interface ToolContext {
  /** Raíz del workspace de la sala. Ninguna tool puede salir de aquí. */
  workspaceDir: string;
  /**
   * Dónde se ejecutan los comandos de bash: el contenedor de la sala o, cuando
   * no hay aislamiento, la máquina del server.
   *
   * Obligatorio a propósito. Antes era opcional y bash caía al runner local
   * cuando faltaba, así que un olvido en cualquier llamador nuevo abría un
   * camino silencioso al host. Quien no tenga contenedor (los demos) tiene que
   * escribir `localRunner` con las manos, y eso se ve en un diff.
   */
  runner: import("../../engine/runner.js").Runner;
  /** Emite un evento observable (ej. file:changed). Opcional (CLI no lo usa). */
  emit?: (event: ToolEvent) => void;
  /** Quién está usando las tools. Para el CAS ("lo tocó Agente-1") y los locks. */
  agentId?: string;
  /** Se llama al empezar/terminar una espera de lock (dos relojes — ver DESIGN.md). */
  onWaitStart?: (info: { path: string; holder?: string }) => void;
  onWaitEnd?: () => void;
  /**
   * Corre SQL contra la base que la sala conectó, o null si no hay ninguna.
   *
   * Se inyecta en vez de que la tool sepa de Supabase, por la misma razón que el
   * runner: las tools no conocen la infraestructura de afuera, reciben lo que
   * pueden hacer. Así el motor sigue sin saber de proveedores, y quien no tenga
   * base conectada simplemente no recibe esto y la tool dice que no hay.
   *
   * Y sobre todo: la credencial NUNCA entra al contenedor. El agente pide que se
   * corra el SQL, y quien lo corre es el server con el permiso de la sala.
   */
  ejecutarSql?: (sql: string) => Promise<void>;
}

export type ToolEvent =
  | { type: "file:changed"; path: string; action: "write" | "edit" | "delete" }
  | { type: "tool:bash"; command: string };

export interface Tool {
  spec: ToolSpec;
  /** Ejecuta la tool. Devuelve el texto de resultado que ve el modelo. */
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

/** Error de tool: se manda de vuelta al modelo como tool_result con is_error. */
export class ToolError extends Error {}

/**
 * Resuelve una ruta relativa DENTRO del workspace y bloquea escapes (../, absolutas).
 * Es la muralla de seguridad: un agente jamás toca archivos fuera de su sala.
 */
export function safePath(workspaceDir: string, rel: string): string {
  if (typeof rel !== "string" || rel.length === 0) {
    throw new ToolError("ruta vacía o inválida");
  }
  // Rechazar rutas absolutas explícitas.
  if (isAbsolute(rel)) {
    throw new ToolError(`ruta absoluta no permitida: ${rel}`);
  }
  const root = resolve(workspaceDir);
  const full = resolve(root, rel);
  const relToRoot = relative(root, full);
  // Si sale del root, relative empieza con ".." o vuelve a ser absoluta.
  if (relToRoot.startsWith("..") || isAbsolute(relToRoot)) {
    throw new ToolError(`la ruta escapa del workspace: ${rel}`);
  }
  return full;
}

/** Helper para leer un campo string obligatorio del input. */
export function reqString(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== "string") throw new ToolError(`falta el parámetro "${key}" (string)`);
  return v;
}

export function optString(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new ToolError(`el parámetro "${key}" debe ser string`);
  return v;
}

export function optBool(input: Record<string, unknown>, key: string): boolean {
  return input[key] === true;
}
