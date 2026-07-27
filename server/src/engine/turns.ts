import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { commitAll } from "./git.js";

/**
 * Turnos con estado DURABLE (en disco, no memoria).
 *
 * Un turno = una tarea de un agente, de principio a fin. Al terminar produce
 * UN commit (la unidad de sentido del scrubber, no un commit por archivo).
 *
 * Por qué durable: si el estado vive en memoria y el server muere, no queda
 * rastro de que un turno quedó a medias — el trabajo estaría en disco pero
 * nadie sabría que nunca se commiteó. Ver DESIGN.md "turnos huérfanos".
 */

export type TurnState = "running" | "committed" | "failed" | "orphaned";

export interface Turn {
  id: string;
  roomId: string;
  agentId: string;
  /** Lo que el humano pidió (para el mensaje del commit). */
  task: string;
  state: TurnState;
  startedAt: number;
  endedAt?: number;
  /** Hash del commit, si llegó a commitear. */
  commit?: string;
  /** Tiempo TRABAJANDO (excluye esperas de lock — ver "dos relojes" en DESIGN.md). */
  activeMs: number;
}

/** El archivo de turnos vive junto al workspace de la sala, no dentro (no se commitea). */
function turnsFile(workspaceDir: string): string {
  return join(dirname(workspaceDir), `${basenameOf(workspaceDir)}.turns.json`);
}

function basenameOf(p: string): string {
  return p.split(/[/\\]/).filter(Boolean).pop() ?? "sala";
}

async function readTurns(workspaceDir: string): Promise<Turn[]> {
  const f = turnsFile(workspaceDir);
  if (!existsSync(f)) return [];
  try {
    return JSON.parse(await readFile(f, "utf8")) as Turn[];
  } catch {
    return [];
  }
}

async function writeTurns(workspaceDir: string, turns: Turn[]): Promise<void> {
  const f = turnsFile(workspaceDir);
  await mkdir(dirname(f), { recursive: true });
  // Atómico: si el server muere escribiendo, no queda un JSON corrupto.
  const tmp = `${f}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(turns, null, 2), "utf8");
  await rename(tmp, f);
}

/** Abre un turno (estado "running" en disco). */
export async function startTurn(
  workspaceDir: string,
  info: { roomId: string; agentId: string; task: string },
): Promise<Turn> {
  const turn: Turn = {
    id: `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    roomId: info.roomId,
    agentId: info.agentId,
    task: info.task,
    state: "running",
    startedAt: Date.now(),
    activeMs: 0,
  };
  const turns = await readTurns(workspaceDir);
  turns.push(turn);
  await writeTurns(workspaceDir, turns);
  return turn;
}

/** Cierra el turno con commit. Devuelve el hash (o null si no hubo cambios). */
export async function commitTurn(
  workspaceDir: string,
  turn: Turn,
  opts: { summary?: string } = {},
): Promise<string | null> {
  const message = opts.summary?.trim() || turn.task.slice(0, 72);
  const hash = await commitAll(workspaceDir, { message, author: turn.agentId });

  await patchTurn(workspaceDir, turn.id, {
    state: "committed",
    endedAt: Date.now(),
    commit: hash ?? undefined,
  });
  return hash;
}

/** Cierra el turno como fallido (el agente reventó). */
export async function failTurn(workspaceDir: string, turnId: string): Promise<void> {
  await patchTurn(workspaceDir, turnId, { state: "failed", endedAt: Date.now() });
}

async function patchTurn(workspaceDir: string, turnId: string, patch: Partial<Turn>): Promise<void> {
  const turns = await readTurns(workspaceDir);
  const t = turns.find((x) => x.id === turnId);
  if (!t) return;
  Object.assign(t, patch);
  await writeTurns(workspaceDir, turns);
}

/**
 * Barrido de arranque: los turnos que quedaron en "running" son huérfanos
 * (un apagado limpio no deja turnos corriendo). Los marca y los devuelve.
 *
 * NO decide qué hacer con ellos: el trabajo ya está en disco y ya lo vieron
 * todos en el preview. Descartarlo solo se sentiría como traición; commitearlo
 * a ciegas metería estados rotos al historial. Lo decide el humano.
 */
export async function sweepOrphans(workspaceDir: string): Promise<Turn[]> {
  const turns = await readTurns(workspaceDir);
  const orphans = turns.filter((t) => t.state === "running");
  if (orphans.length === 0) return [];

  for (const t of orphans) {
    t.state = "orphaned";
    t.endedAt = Date.now();
  }
  await writeTurns(workspaceDir, turns);
  return orphans;
}

export async function listTurns(workspaceDir: string): Promise<Turn[]> {
  return readTurns(workspaceDir);
}
