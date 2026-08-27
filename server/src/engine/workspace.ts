import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
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
 * Vacía de verdad, ni un archivo. Lo que el motor necesita ignorar vive dentro
 * de `.git`, fuera de la vista: si estuviera en la raíz, los generadores de
 * proyecto se plantarían a preguntar si continúan sobre un directorio con
 * archivos, y el primero en correr lo pisaría con el suyo.
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
 * Las reglas de ignorar del motor, en `.git/info/exclude`.
 *
 * NO en un `.gitignore` de la raíz, y esa es la decisión que importa: git lee
 * los dos igual, pero este vive dentro de `.git` y por lo tanto la carpeta de
 * trabajo queda VACÍA.
 *
 * Con un archivo en la raíz, un generador (`npm create`, `create-next-app`…) se
 * planta a preguntar si continúa sobre un directorio que no está vacío, nadie le
 * contesta y se cancela; y el que sí corre escribe su propio `.gitignore`
 * encima, borrando lo del motor sin que nadie se entere. Las dos cosas pasaron
 * de verdad, y le costaban al agente media docena de comandos por sala.
 *
 * Nada de esto es plantilla de proyecto: es la condición para que el historial
 * funcione. Si el proyecto trae su propio `.gitignore`, ese es suyo y se queda.
 */
const MARCA = "# Lo que nunca entra al historial de la sala. Lo pone Multi.";

async function ensureGitignore(dir: string): Promise<void> {
  const path = join(dir, ".git", "info", "exclude");
  // `git init` ya deja aquí un archivo con instrucciones comentadas, así que no
  // vale preguntar si EXISTE: hay que mirar si son NUESTRAS reglas las que están.
  // Saltárselo dejaba el .env sin ignorar, y en silencio.
  const previo = existsSync(path) ? await readFile(path, "utf8") : "";
  if (previo.includes(MARCA)) return;
  const lineas = [
    MARCA,
    "# El proyecto puede tener su propio .gitignore para lo suyo.",
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
    "# El HOME del contenedor de la sala (container.ts). Es cache de npm, no",
    "# proyecto: sin esto entra a los commits y viaja en el .zip que la gente",
    "# se descarga.",
    ".multi-home/",
    "",
    "# La base de datos del proyecto. Los datos de aquí son de prueba: quien se",
    "# lleva la app la quiere publicar con su base vacía, no con lo que se tecleó",
    "# probando. Y en el historial estorban: es un binario que cambia entero en",
    "# cada turno, y regresar a un punto anterior tiraría los datos de hoy junto",
    "# con el código de ayer (el scrubber ya avisa que los datos NO vuelven).",
    "*.db",
    "*.sqlite",
    "*.sqlite3",
    "*.db-shm",
    "*.db-wal",
    "",
  ];
  // Se AÑADE a lo que `git init` dejó, en vez de pisarlo: eso son comentarios de
  // ayuda de git y borrarlos no aporta nada.
  const separador = previo && !previo.endsWith("\n") ? "\n" : "";
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, previo + separador + lineas.join("\n"), "utf8");
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
