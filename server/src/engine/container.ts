import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const execFileP = promisify(execFile);

/**
 * El contenedor de una sala: el lugar donde el agente ejecuta comandos.
 *
 * POR QUÉ existe. Las tools de archivos ya están amarradas al workspace
 * (`safePath` rechaza `../` y rutas absolutas), pero `bash` no puede estarlo:
 * a un shell le pasas `cwd`, que dice dónde EMPIEZA, no hasta dónde LLEGA.
 * Un `cd ..` y salió. Encerrar un shell de verdad no se hace desde el código
 * de la app — lo tiene que hacer el sistema operativo. Eso es el contenedor.
 *
 * En Multi eso importa más que en un agente de un solo usuario: aquí quien
 * manda el comando (tu compa en el chat) NO es el dueño de la máquina donde
 * corre. Y cuando esto se hospede, lo que se protege son unos usuarios de otros.
 *
 * El workspace NO se mueve: sigue en el disco del host, montado como volumen.
 * Así git, el CAS y el historial siguen funcionando sin enterarse de nada.
 */

export const IMAGE_TAG = "multi-room:latest";
const CONTAINER_PREFIX = "multi-room-";

/** Tope de recursos por sala: una sala pesada no debe ahogar a las demás. */
const MEMORY_LIMIT = process.env.MULTI_ROOM_MEMORY ?? "2g";
const CPU_LIMIT = process.env.MULTI_ROOM_CPUS ?? "2";

export interface Container {
  roomId: string;
  name: string;
  /** Puerto del HOST donde sale el dev server de esta sala (lo elige Docker). */
  publishedPort: number | null;
}

// ── Disponibilidad de Docker ────────────────────────────────────────────────

let dockerAvailable: boolean | null = null;

/**
 * ¿Hay un Docker usable? Se resuelve UNA vez y se recuerda.
 *
 * No basta con que el binario exista: en WSL el CLI de Windows aparece en el
 * PATH pero no puede hablar con el daemon. Por eso se pregunta al daemon.
 */
export async function isDockerAvailable(): Promise<boolean> {
  if (dockerAvailable !== null) return dockerAvailable;
  try {
    await execFileP("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 15_000 });
    dockerAvailable = true;
  } catch {
    dockerAvailable = false;
  }
  return dockerAvailable;
}

/** Construye la imagen de las salas si todavía no existe. Idempotente. */
export async function ensureImage(repoRoot: string): Promise<void> {
  const { stdout } = await execFileP("docker", ["images", "-q", IMAGE_TAG]);
  if (stdout.trim().length > 0) return;

  console.log(`[docker] construyendo la imagen ${IMAGE_TAG} (solo la primera vez)…`);
  await execFileP(
    "docker",
    ["build", "-t", IMAGE_TAG, "-f", join(repoRoot, "docker", "room.Dockerfile"), repoRoot],
    { timeout: 600_000, maxBuffer: 10 * 1024 * 1024 },
  );
  console.log(`[docker] imagen lista`);
}

// ── Ciclo de vida ───────────────────────────────────────────────────────────

/**
 * Arranca (o reusa) el contenedor de una sala.
 *
 * `devPort` es el puerto donde el dev server escuchará ADENTRO; Docker lo publica
 * en un puerto libre del host, que es el que el proxy termina usando.
 */
export async function startContainer(
  roomId: string,
  workspaceDir: string,
  devPort: number,
): Promise<Container> {
  const name = CONTAINER_PREFIX + roomId;

  const existing = await containerState(name);
  if (existing === "running") {
    return { roomId, name, publishedPort: await readPublishedPort(name, devPort) };
  }
  // Un contenedor parado con la config vieja no sirve: se rehace.
  if (existing !== null) await removeContainer(name);

  await execFileP("docker", [
    "run",
    "-d",
    "--name", name,
    // El proyecto vive en el host; adentro se ve como /work.
    "-v", `${workspaceDir}:/work`,
    "--workdir", "/work",
    // Puerto 0 = que Docker elija uno libre del host. Evita colisiones entre salas.
    "-p", `0:${devPort}`,
    "--memory", MEMORY_LIMIT,
    "--cpus", CPU_LIMIT,
    // Sin privilegios extra y sin poder ganarlos (un sudo dentro no escala).
    "--security-opt", "no-new-privileges",
    // Si el server de Multi muere, el contenedor no se queda huérfano para siempre.
    "--label", "multi.room=" + roomId,
    IMAGE_TAG,
  ], { timeout: 60_000 });

  return { roomId, name, publishedPort: await readPublishedPort(name, devPort) };
}

/** Para y borra el contenedor de una sala. No falla si ya no existe. */
export async function stopContainer(roomId: string): Promise<void> {
  await removeContainer(CONTAINER_PREFIX + roomId);
}

async function removeContainer(name: string): Promise<void> {
  try {
    await execFileP("docker", ["rm", "-f", name], { timeout: 30_000 });
  } catch {
    // Ya no existía: es el estado deseado.
  }
}

/** "running" | "exited" | ... o null si no existe. */
async function containerState(name: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP("docker", [
      "inspect", "-f", "{{.State.Status}}", name,
    ]);
    return stdout.trim();
  } catch {
    return null;
  }
}

/** El puerto del host al que Docker mapeó el puerto interno. */
async function readPublishedPort(name: string, devPort: number): Promise<number | null> {
  try {
    const { stdout } = await execFileP("docker", ["port", name, String(devPort)]);
    // Formato: "0.0.0.0:49154" (y a veces varias líneas, IPv4 e IPv6).
    const m = stdout.match(/:(\d+)\s*$/m);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Barre contenedores de salas que quedaron de una corrida anterior.
 *
 * Mismo criterio que el barrido de turnos huérfanos: si el server murió de
 * golpe, los contenedores siguen vivos comiendo RAM y ocupando puertos.
 */
export async function sweepOrphanContainers(): Promise<number> {
  try {
    const { stdout } = await execFileP("docker", [
      "ps", "-aq", "--filter", "label=multi.room",
    ]);
    const ids = stdout.trim().split("\n").filter(Boolean);
    if (ids.length === 0) return 0;
    await execFileP("docker", ["rm", "-f", ...ids], { timeout: 60_000 });
    return ids.length;
  } catch {
    return 0;
  }
}

// ── Ejecución ───────────────────────────────────────────────────────────────

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  /** El comando se mató por timeout. */
  timedOut: boolean;
}

/**
 * Corre un comando DENTRO del contenedor de la sala.
 *
 * Misma forma que el spawn local que reemplaza (shell, timeout, salida
 * truncada), para que la tool de bash no tenga que saber cuál está usando.
 */
export function execInContainer(
  roomId: string,
  command: string,
  opts: { timeoutMs: number; maxOutput: number },
): Promise<ExecResult> {
  const name = CONTAINER_PREFIX + roomId;

  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["exec", "-i", name, "sh", "-c", command]);

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);

    child.stdout.on("data", (d) => {
      if (stdout.length < opts.maxOutput) stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < opts.maxOutput) stderr += d.toString();
    });

    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
  });
}

/** Arranca un proceso largo (el dev server) adentro. Devuelve el hijo para poder matarlo. */
export function spawnInContainer(roomId: string, command: string, env: Record<string, string>) {
  const name = CONTAINER_PREFIX + roomId;
  const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  return spawn("docker", ["exec", "-i", ...envArgs, name, "sh", "-c", command], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}
