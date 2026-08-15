import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { KeyedMutex } from "./keyed-mutex.js";

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

/**
 * Un arranque a la vez por sala. Crear un contenedor no es atómico (se consulta
 * el estado y luego se corre `docker run`), así que dos llamadas simultáneas
 * pisan la misma ventana y la segunda choca por nombre duplicado.
 */
const arranques = new KeyedMutex();

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

  // Serializado por sala: al despertar, `bootPreview` y el primer turno del
  // agente pueden pedir el contenedor casi a la vez. Sin esto los dos ven "no
  // existe", los dos hacen `docker run`, y el segundo choca con
  // "Conflict. The container name is already in use" — la sala no arranca.
  return arranques.run(name, async () => {
    const existing = await containerState(name);
    if (existing === "running") {
      return { roomId, name, publishedPort: await readPublishedPort(name, devPort) };
    }
    // Un contenedor parado con la config vieja no sirve: se rehace.
    if (existing !== null) await removeContainer(name);

    // Los argumentos van en UNA sola lista porque abajo hay un reintento: con
    // dos copias, cualquier arreglo que se hiciera aquí y no allá revivía en el
    // segundo intento. Ya pasó con `--user`.
    const args = [
      "run",
      "-d",
      "--name", name,
      // El proyecto vive en el host; adentro se ve como /work.
      "-v", `${workspaceDir}:/work`,
      "--workdir", "/work",
      /**
       * El contenedor corre como el MISMO usuario que el server de Multi.
       *
       * El workspace es una carpeta del host montada adentro, y sus archivos
       * son de quien corre Multi. Si adentro se es otro usuario, el proyecto se
       * ve pero no se puede escribir: `npm install` falla con EACCES y el agente
       * cree que el stack no se puede instalar. En vez de parar, improvisa (lo
       * vimos armar una landing "sin dependencias" para esquivarlo), así que el
       * síntoma no es un error sino trabajo entregado a medias.
       *
       * No se ve en desarrollo porque ahí tu usuario suele ser uid 1000, el
       * mismo que trae la imagen. Sale en cuanto Multi corre como root, que es
       * lo normal en un servidor.
       */
      "--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      /**
       * Y con un HOME que ese usuario sí posea.
       *
       * La imagen trae HOME=/home/node, de `node`. Al entrar como otro usuario
       * esa carpeta es ajena, y npm escribe ahí su caché y su config antes de
       * instalar nada: sin esto, arreglar el dueño del workspace no alcanzaba y
       * `npm install` seguía muriendo, ahora por el caché.
       *
       * Va dentro del propio workspace porque es lo único que con certeza le
       * pertenece a quien corre Multi. Queda en `.multi-home`, con punto: los
       * `.gitignore` que escriben los agentes suelen ignorar los ocultos, y de
       * todos modos el del motor ya excluye lo pesado.
       */
      "--env", "HOME=/work/.multi-home",
      "--env", "npm_config_cache=/work/.multi-home/.npm",
      // Puerto 0 = que Docker elija uno libre del host. Evita colisiones entre salas.
      "-p", `0:${devPort}`,
      "--memory", MEMORY_LIMIT,
      "--cpus", CPU_LIMIT,
      // Sin privilegios extra y sin poder ganarlos (un sudo dentro no escala).
      "--security-opt", "no-new-privileges",
      // Si el server de Multi muere, el contenedor no se queda huérfano para siempre.
      "--label", "multi.room=" + roomId,
      IMAGE_TAG,
    ];

    try {
      await execFileP("docker", args, { timeout: 60_000 });
    } catch (err) {
      // Cinturón por si el nombre quedó tomado de todos modos (un contenedor
      // que Docker seguía borrando, por ejemplo): se limpia y se reintenta una vez.
      if (!String(err).includes("already in use")) throw err;
      await removeContainer(name);
      await execFileP("docker", args, { timeout: 60_000 });
    }

    return { roomId, name, publishedPort: await readPublishedPort(name, devPort) };
  });
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
  opts: {
    timeoutMs: number;
    maxOutput: number;
    /**
     * Variables solo para ESTE comando, no para el contenedor.
     *
     * Es el camino por el que el token de la plataforma de deploy llega a
     * `wrangler`: vive en el `.env` del server, entra con el comando y se va con
     * él. No queda en el `docker run`, no queda en el `.env` del proyecto, y el
     * agente no lo encuentra aunque vaya a buscarlo.
     *
     * Por aquí y no interpolado en el comando: ahí quedaría a la vista en la
     * lista de procesos de adentro.
     */
    env?: Record<string, string>;
  },
): Promise<ExecResult> {
  const name = CONTAINER_PREFIX + roomId;
  const envArgs = Object.entries(opts.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);

  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["exec", "-i", ...envArgs, name, "sh", "-c", command]);

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

  /**
   * El workspace está montado desde el host, y los eventos de cambio de archivo
   * (inotify) NO cruzan esa frontera — menos aún desde /mnt/c en WSL, donde ya
   * vienen atravesando Windows. Sin esto el dev server nunca se entera de que el
   * agente escribió algo, y el preview se queda congelado: hay que reiniciarlo a
   * mano para ver cada cambio, que es justo lo contrario del producto.
   *
   * Va por entorno, no en el vite.config: el motor no debe depender de que el
   * agente escriba la config correcta, y estas variables las respetan también
   * Next, Nuxt, Astro y demás (todos usan chokidar por debajo).
   */
  const watchEnv = {
    CHOKIDAR_USEPOLLING: "1",
    CHOKIDAR_INTERVAL: "300",
    WATCHPACK_POLLING: "true", // webpack (Next)
    ...env,
  };

  const envArgs = Object.entries(watchEnv).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  return spawn("docker", ["exec", "-i", ...envArgs, name, "sh", "-c", command], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}
