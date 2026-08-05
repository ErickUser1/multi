import { mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// Raíz donde vive el workspace de cada sala. Gitignored en el repo de Multi;
// cada workspace tiene SU propio git (el estado del proyecto del usuario).
export const WORKSPACES_ROOT = join(process.cwd(), "..", "workspaces");

export interface Workspace {
  roomId: string;
  dir: string;
}

/**
 * Crea el workspace de una sala: una carpeta vacía con git.
 *
 * La sala NACE VACÍA — cero molde, cero stack asumido. El proyecto lo scaffoldea
 * el AGENTE según lo que pida el usuario, igual que trabajarías con un compa:
 * tú dices "hazme un Next con Tailwind" y él corre el comando. Sembrar aquí un
 * proyecto de arranque sería meter una plantilla por la puerta de atrás y dejar
 * de ser agnósticos (era andamio de la Fase 0 para probar el motor; ya no).
 *
 * Lo único que se siembra es `.gitignore`, y eso SÍ es del motor: sin él,
 * `git add -A` indexa node_modules y los turnos nunca commitean.
 */
export async function createWorkspace(
  roomId: string,
  opts: { clean?: boolean } = {},
): Promise<Workspace> {
  const dir = join(WORKSPACES_ROOT, roomId);

  if (opts.clean && existsSync(dir)) {
    await rm(dir, { recursive: true, force: true });
  }
  await mkdir(dir, { recursive: true });

  // Solo inicializar si no está ya: `git init` sobre un repo existente reescribe
  // el config, y si el proceso muere a media escritura deja un config.lock que
  // hace fallar TODOS los arranques siguientes — la sala queda inaccesible.
  // (Pasó de verdad: el server no volvía a levantar tras un reinicio a destiempo.)
  if (!existsSync(join(dir, ".git"))) {
    await execFileP("git", ["init", "-q"], { cwd: dir });
    // Config local para que los commits del motor no dependan del git global.
    await execFileP("git", ["config", "user.name", "Multi"], { cwd: dir });
    await execFileP("git", ["config", "user.email", "motor@multi.local"], { cwd: dir });
  } else {
    await limpiarLocksHuerfanos(dir);
  }

  await ensureGitignore(dir);

  return { roomId, dir };
}

/**
 * Siembra el `.gitignore` del motor si no existe.
 *
 * No es plantilla de proyecto: es la condición para que el historial funcione.
 * Si el agente después lo edita para su stack, se respeta (por eso no se pisa).
 */
async function ensureGitignore(dir: string): Promise<void> {
  const path = join(dir, ".gitignore");
  if (existsSync(path)) return;
  const lineas = [
    "# Lo que nunca entra al historial de la sala.",
    "# El agente puede agregar lo que su stack necesite.",
    "node_modules/",
    "dist/",
    "build/",
    ".next/",
    ".nuxt/",
    ".vite/",
    ".env",
    ".env.*",
    "*.log",
    "",
    "# Temporales de la escritura atómica (file-mutation.ts: temp + rename). Si el",
    "# proceso muere entre los dos pasos, queda uno tirado; sin esto entraría al",
    "# commit del turno.",
    "*.tmp-*",
    "",
  ];
  await writeFile(path, lineas.join("\n"), "utf8");
}

/**
 * Borra los .lock que git deja cuando lo matan a media operación.
 *
 * Git usa archivos de bloqueo (`config.lock`, `index.lock`) para no corromperse
 * si dos procesos escriben a la vez. Si el proceso muere antes de soltarlos, se
 * quedan ahí y toda operación posterior falla con "File exists" — para siempre,
 * porque nadie los va a quitar solo. Al arrancar la sala no hay nadie más
 * trabajando en ella, así que un lock presente es basura de una corrida anterior.
 */
async function limpiarLocksHuerfanos(dir: string): Promise<void> {
  for (const nombre of ["config.lock", "index.lock", "HEAD.lock"]) {
    const path = join(dir, ".git", nombre);
    if (existsSync(path)) {
      await rm(path, { force: true });
      console.warn(`[workspace] quitado ${nombre} huérfano en ${dir}`);
    }
  }
}
