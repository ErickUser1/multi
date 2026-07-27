import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { log, filesInCommit, type CommitInfo } from "./git.js";
import { listTurns } from "./turns.js";

/**
 * Historial de una sala: la línea de tiempo que alimenta el scrubber.
 *
 * Cada punto es un turno de agente (un commit). El humano puede previsualizar
 * cualquier punto sin tocar el presente, marcar los que importan (bookmarks) y
 * regresar a uno — siempre como commit nuevo, sin borrar historia.
 */

export interface HistoryEntry extends CommitInfo {
  /** Marcado por un humano ("la versión que funcionaba"). */
  bookmark?: string;
  files: string[];
  /**
   * La tarea que produjo este commit — sirve para saltar a la conversación
   * ("¿por qué pasó este cambio?"), patrón "go to message in chat" de Lovable.
   */
  task?: string;
}

/** Los bookmarks viven junto al workspace, no dentro (no se commitean). */
function bookmarksFile(workspaceDir: string): string {
  return join(dirname(workspaceDir), `${workspaceDir.split(/[/\\]/).filter(Boolean).pop()}.bookmarks.json`);
}

async function readBookmarks(workspaceDir: string): Promise<Record<string, string>> {
  const f = bookmarksFile(workspaceDir);
  if (!existsSync(f)) return {};
  try {
    return JSON.parse(await readFile(f, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

export async function setBookmark(
  workspaceDir: string,
  hash: string,
  label: string | null,
): Promise<void> {
  const marks = await readBookmarks(workspaceDir);
  if (label) marks[hash] = label;
  else delete marks[hash];
  const f = bookmarksFile(workspaceDir);
  await mkdir(dirname(f), { recursive: true });
  await writeFile(f, JSON.stringify(marks, null, 2), "utf8");
}

/** La línea de tiempo completa, del más nuevo al más viejo. */
export async function getHistory(workspaceDir: string, limit = 100): Promise<HistoryEntry[]> {
  const [commits, marks, turns] = await Promise.all([
    log(workspaceDir, limit),
    readBookmarks(workspaceDir),
    listTurns(workspaceDir).catch(() => []),
  ]);
  // Ligar cada commit con el turno que lo produjo, para saber QUÉ se pidió.
  const byCommit = new Map(turns.filter((t) => t.commit).map((t) => [t.commit!, t]));
  return Promise.all(
    commits.map(async (c) => ({
      ...c,
      bookmark: marks[c.hash],
      task: byCommit.get(c.hash)?.task,
      files: await filesInCommit(workspaceDir, c.hash),
    })),
  );
}

/**
 * PENDIENTE (ver DESIGN.md): previsualizar visualmente un estado anterior — la
 * app viva del pasado, como hace Lovable. Requiere build bajo demanda del
 * commit (el árbol guardado es código fuente, el navegador no lo ejecuta).
 * v1 arranca sin esto: el diff responde "¿qué cambió?" y "regresar aquí" sí
 * muestra el estado vivo porque restaura el working tree.
 * `extractTo` en git.ts queda listo para cuando se retome.
 */
