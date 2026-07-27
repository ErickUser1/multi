import { execFile } from "node:child_process";
import { promisify } from "node:util";

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

/** Archivos que cambiaron en un commit (para saber qué tocó cada turno). */
export async function filesInCommit(dir: string, hash: string): Promise<string[]> {
  const { stdout } = await execFileP(
    "git",
    ["show", "--name-only", "--format=", hash],
    { cwd: dir },
  ).catch(() => ({ stdout: "" }));
  return stdout.split("\n").filter(Boolean);
}
