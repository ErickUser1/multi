import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { KeyedMutex } from "./keyed-mutex.js";

const execFileP = promisify(execFile);

/**
 * Operaciones git del workspace de una sala.
 * Es el Canal 2 (guardado/historial): commit por turno de agente.
 * NO es el camino del tiempo real — eso va por HMR sin esperar commits.
 *
 * Todas las operaciones que ESCRIBEN se serializan por repositorio: git usa un
 * `index.lock` para protegerse, y si dos procesos entran a la vez el segundo
 * revienta con "Unable to create index.lock: File exists". Pasa de verdad en
 * cuanto dos agentes cierran turno al mismo tiempo — que es justo el caso normal
 * del producto. El CAS protege los archivos; esto protege el índice de git.
 *
 * Es el mismo KeyedMutex de las escrituras: misma clave (el repo) hace fila,
 * repos distintos van en paralelo. Salas distintas no se estorban.
 */
const gitMutex = new KeyedMutex();

/** Corre una operación de escritura de git en exclusión mutua para ese repo. */
function conLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  return gitMutex.run(dir, async () => {
    // Un lock que sobrevivió a un proceso muerto bloquea el repo para siempre.
    // Bajo nuestro propio lock no hay nadie más trabajando, así que si está,
    // es basura de una corrida anterior.
    const lock = join(dir, ".git", "index.lock");
    if (existsSync(lock)) {
      await rm(lock, { force: true });
      console.warn(`[git] quitado index.lock huérfano en ${dir}`);
    }
    return fn();
  });
}

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
  return conLock(dir, () => commitSinLock(dir, opts));
}

/**
 * El commit en sí, SIN tomar el lock.
 *
 * Existe aparte porque `revertTo` y `revertFile` ya corren dentro del lock y
 * necesitan commitear al final: el mutex no es reentrante, así que llamar a
 * `commitAll` desde ahí se quedaría esperándose a sí mismo para siempre.
 */
async function commitSinLock(
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
  return conLock(dir, async () => {
    const hasHead = await execFileP("git", ["rev-parse", "--verify", "HEAD"], { cwd: dir })
      .then(() => true)
      .catch(() => false);
    if (!hasHead) return; // sin commits todavía: no hay punto al que volver
    await execFileP("git", ["reset", "--hard", "HEAD"], { cwd: dir });
    await execFileP("git", ["clean", "-fd"], { cwd: dir });
  });
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
  return conLock(dir, async () => {
    // Traer el árbol de ese commit al working tree, sin mover HEAD.
    await execFileP("git", ["restore", "--source", hash, "--worktree", "--staged", "."], {
      cwd: dir,
    });
    return commitSinLock(dir, {
      message: opts.message ?? `volver al estado de ${hash.slice(0, 7)}`,
      author: opts.author,
    });
  });
}

/** Restaura UN archivo al estado de un commit (revert selectivo). */
export async function revertFile(
  dir: string,
  hash: string,
  file: string,
  opts: { author: string },
): Promise<string | null> {
  return conLock(dir, async () => {
    await execFileP("git", ["restore", "--source", hash, "--worktree", "--staged", "--", file], {
      cwd: dir,
    });
    return commitSinLock(dir, {
      message: `volver ${file} al estado de ${hash.slice(0, 7)}`,
      author: opts.author,
    });
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

/** Si el repo tiene al menos un commit. Una sala recién creada no tiene ninguno. */
export async function hayCommits(dir: string): Promise<boolean> {
  return execFileP("git", ["rev-parse", "--verify", "HEAD"], { cwd: dir })
    .then(() => true)
    .catch(() => false);
}

/**
 * Si hay trabajo en el working tree que no está en ningún commit.
 *
 * Sirve para AVISAR antes de exportar: el zip sale de HEAD, o sea del último
 * turno cerrado. Si un agente está a media escritura, eso no viaja. Es mejor
 * decirlo que entregar un zip al que le falta lo que la persona acaba de ver
 * en el preview.
 *
 * Va por `status --porcelain` y NO por el `diff-index --quiet` que usa
 * `commitSinLock`: aquel compara el índice contra HEAD, y un archivo recién
 * creado todavía no está en el índice, así que para él "no hay cambios".
 * `commitSinLock` no lo sufre porque hace `git add -A` justo antes; aquí no
 * podemos, porque exportar no debe escribir nada en el repo de la sala.
 *
 * La diferencia no es teórica: un agente que crea archivos nuevos (el caso
 * normal de un turno a medias) no se detectaba con `diff-index`.
 *
 * Sin ningún commit todavía se responde `false`: la sala recién nacida solo
 * tiene el `.gitignore` del motor sin trackear, y llamar a eso "trabajo sin
 * guardar" sería avisar de algo que nadie escribió.
 */
export async function tieneCambiosSinCommitear(dir: string): Promise<boolean> {
  if (!(await hayCommits(dir))) return false;
  const { stdout } = await execFileP("git", ["status", "--porcelain"], {
    cwd: dir,
    maxBuffer: 5 * 1024 * 1024,
  }).catch(() => ({ stdout: "" }));
  return stdout.trim().length > 0;
}

/**
 * El proyecto de la sala como un .zip, listo para descargar.
 *
 * Sale de `git archive HEAD`, no del directorio: lo que nunca entró a un commit
 * no puede salir en el zip. Eso deja fuera `node_modules/`, `dist/`, `.env` y
 * lo demás del .gitignore que siembra el motor (workspace.ts) SIN filtro manual
 * que se pueda equivocar y colar un secreto.
 *
 * No toma el lock de git a propósito: `archive` lee del object store y no toca
 * el índice, igual que `log` y `diffCommit`. Si un agente commitea justo
 * mientras esto corre, el zip sale con el commit de antes o el de después,
 * nunca a medias.
 *
 * `encoding: "buffer"` NO es opcional: sin él execFile decodifica la salida
 * como utf8 y el zip queda corrupto sin dar ningún error. Se descubre hasta
 * que alguien intenta abrirlo.
 */
export async function exportarZip(dir: string): Promise<Buffer> {
  const { stdout } = await execFileP("git", ["archive", "--format=zip", "HEAD"], {
    cwd: dir,
    encoding: "buffer",
    // Un proyecto con imágenes se pasa del default (1MB) sin ser nada raro.
    maxBuffer: 100 * 1024 * 1024,
  });
  return stdout;
}
