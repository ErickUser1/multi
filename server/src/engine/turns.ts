import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { commitAll, filesInCommit } from "./git.js";
import { KeyedMutex } from "./keyed-mutex.js";

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
  // Atómico: si el server muere escribiendo, no queda un JSON corrupto. El
  // nombre temporal es único por escritura: con uno por proceso, dos escrituras
  // a la vez renombraban el mismo archivo y la segunda tronaba con ENOENT.
  const tmp = `${f}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, JSON.stringify(turns, null, 2), "utf8");
  await rename(tmp, f);
}

/**
 * Leer, cambiar y escribir el archivo de turnos de una sala, de uno en uno.
 *
 * Dos agentes que empiezan turno a la vez (dos personas escriben @agente en el
 * mismo momento) leían los dos la lista, agregaban cada uno el suyo y el último
 * en escribir borraba el turno del otro. Y como compartían el nombre temporal,
 * el segundo `rename` tronaba sin que nadie lo atrapara y TUMBABA EL SERVER,
 * con todas las salas.
 */
const candadoDeTurnos = new KeyedMutex();

async function modificarTurnos<T>(workspaceDir: string, fn: (turns: Turn[]) => T): Promise<T> {
  return candadoDeTurnos.run(turnsFile(workspaceDir), async () => {
    const turns = await readTurns(workspaceDir);
    const antes = JSON.stringify(turns);
    const resultado = fn(turns);
    // Sin cambios no se escribe: el barrido de arranque pasa por todas las
    // salas, y no tiene por qué crearle un archivo a cada una.
    if (JSON.stringify(turns) !== antes) await writeTurns(workspaceDir, turns);
    return resultado;
  });
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
  await modificarTurnos(workspaceDir, (turns) => {
    turns.push(turn);
  });
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

/**
 * Cierra el turno como fallido PERO commitea lo que alcanzó a escribir.
 *
 * Un stream que se corta a media generación deja archivos completos en disco (la
 * escritura es atómica: temp + rename), y sin commit quedan fuera del historial de
 * la sala: nadie puede volver a ese punto ni ver qué se hizo. Se guardan como un
 * punto más de la línea de tiempo, marcado como cortado.
 *
 * El turno sigue siendo `failed`: `state` dice CÓMO terminó y `commit` dice DÓNDE
 * quedó el trabajo. Son campos independientes a propósito.
 */
export async function failTurnConCommit(
  workspaceDir: string,
  turn: Turn,
  opts: { summary?: string } = {},
): Promise<string | null> {
  const message = opts.summary?.trim() || turn.task.slice(0, 72);
  const hash = await commitAll(workspaceDir, { message, author: turn.agentId });

  await patchTurn(workspaceDir, turn.id, {
    state: "failed",
    endedAt: Date.now(),
    commit: hash ?? undefined,
  });
  return hash;
}

async function patchTurn(workspaceDir: string, turnId: string, patch: Partial<Turn>): Promise<void> {
  await modificarTurnos(workspaceDir, (turns) => {
    const t = turns.find((x) => x.id === turnId);
    if (t) Object.assign(t, patch);
  });
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
  return modificarTurnos(workspaceDir, (turns) => {
    const orphans = turns.filter((t) => t.state === "running");
    for (const t of orphans) {
      t.state = "orphaned";
      t.endedAt = Date.now();
    }
    return orphans;
  });
}

export async function listTurns(workspaceDir: string): Promise<Turn[]> {
  return readTurns(workspaceDir);
}

/**
 * Los turnos de OTROS agentes que terminaron después del último turno de
 * `agentId`: lo que cambió en el proyecto mientras él no estaba.
 *
 * Es lo que le faltaba al resumen en vivo, que solo cubre los últimos minutos.
 * Pasó de verdad: un agente volvió a trabajar seis minutos después de que otro
 * terminara su parte, no supo que existía, y la borró. Aquí no hay ventana de
 * tiempo: si pasó después de tu último turno, te lo cuentan.
 *
 * Un agente nuevo (sin turnos) recibe los últimos `max`: no hay "desde", pero sí
 * un proyecto que otros ya armaron. Solo cuentan los turnos con commit, que son
 * los que dejaron algo en el proyecto.
 */
export async function turnosDeOtrosDesde(
  workspaceDir: string,
  agentId: string,
  opts: { max?: number } = {},
): Promise<{ turnos: Turn[]; fuera: number; esNuevo: boolean }> {
  const { max = 5 } = opts;
  const turns = await readTurns(workspaceDir);
  // El turno que está corriendo (el suyo, recién abierto) no cuenta como "último".
  const mios = turns.filter((t) => t.agentId === agentId && t.state !== "running" && t.endedAt);
  const desde = mios.length ? Math.max(...mios.map((t) => t.endedAt!)) : 0;
  const nuevos = turns
    .filter((t) => t.agentId !== agentId && t.commit && (t.endedAt ?? 0) > desde)
    .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
  return {
    turnos: nuevos.slice(-max),
    fuera: Math.max(0, nuevos.length - max),
    esNuevo: mios.length === 0,
  };
}

/**
 * Lo mismo, listo para el resumen que recibe el agente: cada turno con los
 * archivos que dejó en su commit.
 */
export async function trabajoDeOtrosDesde(
  workspaceDir: string,
  agentId: string,
): Promise<{
  turnos: Array<{ agentId: string; task: string; archivos: string[] }>;
  fuera: number;
  esNuevo: boolean;
}> {
  const { turnos, fuera, esNuevo } = await turnosDeOtrosDesde(workspaceDir, agentId);
  const conArchivos = await Promise.all(
    turnos.map(async (t) => ({
      agentId: t.agentId,
      task: t.task,
      archivos: await filesInCommit(workspaceDir, t.commit!),
    })),
  );
  return { turnos: conArchivos, fuera, esNuevo };
}
