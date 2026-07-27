import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";

const execFileP = promisify(execFile);

/**
 * Operaciones git del workspace de una sala.
 * Es el Canal 2 (guardado/historial): commit por turno de agente.
 * NO es el camino del tiempo real — eso va por HMR sin esperar commits.
 */

export interface CommitInfo {
  hash: string;
  message: string;
  /** Autor del commit = el agente que hizo el turno. */
  author: string;
  date: string;
}

/** Commitea todo lo que haya cambiado. Devuelve el hash, o null si no había nada. */
export async function commitAll(
  dir: string,
  opts: { message: string; author: string },
): Promise<string | null> {
  await execFileP("git", ["add", "-A"], { cwd: dir });

  // ¿Hay algo que commitear? (diff-index falla con código 1 si hay cambios)
  const hasChanges = await execFileP("git", ["diff-index", "--quiet", "HEAD", "--"], { cwd: dir })
    .then(() => false)
    .catch(() => true);
  // Caso especial: repo sin ningún commit todavía.
  const hasHead = await execFileP("git", ["rev-parse", "--verify", "HEAD"], { cwd: dir })
    .then(() => true)
    .catch(() => false);

  if (hasHead && !hasChanges) return null;

  await execFileP(
    "git",
    [
      "-c",
      `user.name=${opts.author}`,
      "-c",
      "user.email=agente@multi.local",
      "commit",
      "-q",
      "-m",
      opts.message,
    ],
    { cwd: dir },
  );

  const { stdout } = await execFileP("git", ["rev-parse", "HEAD"], { cwd: dir });
  return stdout.trim();
}

/**
 * Descarta los cambios no commiteados (vuelve al último punto guardado).
 * Solo se llama por decisión explícita del humano.
 */
export async function discardChanges(dir: string): Promise<void> {
  const hasHead = await execFileP("git", ["rev-parse", "--verify", "HEAD"], { cwd: dir })
    .then(() => true)
    .catch(() => false);
  if (!hasHead) return; // sin commits todavía: no hay punto al que volver
  await execFileP("git", ["reset", "--hard", "HEAD"], { cwd: dir });
  await execFileP("git", ["clean", "-fd"], { cwd: dir });
}

/** Historial de la sala — alimenta el scrubber (Fase 5). */
export async function log(dir: string, limit = 100): Promise<CommitInfo[]> {
  const SEP = "";
  const { stdout } = await execFileP(
    "git",
    ["log", `--max-count=${limit}`, `--format=%H${SEP}%an${SEP}%aI${SEP}%s`],
    { cwd: dir },
  ).catch(() => ({ stdout: "" }));

  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, author, date, message] = line.split(SEP);
      return { hash, author, date, message };
    });
}

/** Diff de un commit contra su padre, en texto unificado. */
export async function diffCommit(dir: string, hash: string): Promise<string> {
  const { stdout } = await execFileP(
    "git",
    ["show", "--format=", "--patch", "--unified=3", hash],
    { cwd: dir, maxBuffer: 5 * 1024 * 1024 },
  ).catch(() => ({ stdout: "" }));
  return stdout;
}

/**
 * Extrae el árbol de un commit a un directorio, sin tocar el working tree.
 * Así se puede PREVISUALIZAR un estado anterior mientras otros siguen
 * trabajando en el presente.
 */
export async function extractTo(dir: string, hash: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  // git archive escribe el árbol del commit; tar lo desempaqueta en destino.
  await execFileP("sh", ["-c", `git archive ${hash} | tar -x -C ${JSON.stringify(destDir)}`], {
    cwd: dir,
    maxBuffer: 50 * 1024 * 1024,
  });
}

/**
 * Restaura el proyecto al estado de un commit, pero como un COMMIT NUEVO.
 * Nunca reescribe la historia: todo lo posterior sigue disponible para
 * reaplicarse (patrón Lovable).
 */
export async function revertTo(
  dir: string,
  hash: string,
  opts: { author: string; message?: string },
): Promise<string | null> {
  // Traer el árbol de ese commit al working tree, sin mover HEAD.
  await execFileP("git", ["restore", "--source", hash, "--worktree", "--staged", "."], { cwd: dir });
  return commitAll(dir, {
    message: opts.message ?? `volver al estado de ${hash.slice(0, 7)}`,
    author: opts.author,
  });
}

/** Restaura UN archivo al estado de un commit (revert selectivo). */
export async function revertFile(
  dir: string,
  hash: string,
  file: string,
  opts: { author: string },
): Promise<string | null> {
  await execFileP("git", ["restore", "--source", hash, "--worktree", "--staged", "--", file], {
    cwd: dir,
  });
  return commitAll(dir, {
    message: `volver ${file} al estado de ${hash.slice(0, 7)}`,
    author: opts.author,
  });
}

/** Archivos que cambiaron en un commit (para saber qué tocó cada turno). */
export async function filesInCommit(dir: string, hash: string): Promise<string[]> {
  const { stdout } = await execFileP(
    "git",
    ["show", "--name-only", "--format=", hash],
    { cwd: dir },
  ).catch(() => ({ stdout: "" }));
  return stdout.split("\n").filter(Boolean);
}
