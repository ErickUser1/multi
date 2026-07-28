import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Workspace } from "./workspace.js";
import { spawnInContainer } from "./container.js";

export interface Preview {
  roomId: string;
  port: number;
  url: string;
  process: ChildProcess;
  stop: () => Promise<void>;
}

// Rango de puertos para dev servers de salas. Una sala = un puerto.
const BASE_PORT = 5200;
const MAX_PORT = 5400;
const usedPorts = new Set<number>();

/** ¿El puerto está realmente libre en el sistema? */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

/**
 * Siguiente puerto libre. Verifica contra el SISTEMA, no solo contra el Set:
 * si el server reinició, procesos huérfanos de salas viejas pueden seguir
 * ocupando puertos que el Set ya no recuerda (bug real que causaba 502 en el
 * proxy: se asignaba un puerto ocupado por el vite de una sala muerta).
 */
async function nextPort(): Promise<number> {
  for (let p = BASE_PORT; p <= MAX_PORT; p++) {
    if (usedPorts.has(p)) continue;
    if (await isPortFree(p)) {
      usedPorts.add(p);
      return p;
    }
  }
  throw new Error(`no hay puertos libres en el rango ${BASE_PORT}-${MAX_PORT}`);
}

/** Cómo levantar el proyecto. Sale de lo que el AGENTE escribió, no de un molde. */
export interface Launch {
  command: string;
  args: string[];
  /** Variable por la que se le pasa el puerto (la mayoría de dev servers usan PORT). */
  portEnv?: string;
}

/**
 * ¿Hay algo que levantar en este workspace?
 *
 * La sala nace vacía: hasta que el agente no scaffoldee un proyecto, no hay dev
 * server que arrancar y eso NO es un error — es el estado normal al empezar.
 *
 * No asume el stack: lee lo que el proyecto declara. Hoy soporta `package.json`
 * con un script de desarrollo (cubre Vite, Next, Nuxt, Astro, Remix y demás).
 * Otros ecosistemas se suman aquí, sin tocar el resto del motor.
 */
export async function detectLaunch(dir: string): Promise<Launch | null> {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) return null;

  let scripts: Record<string, string> = {};
  try {
    const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
    scripts = pkg?.scripts ?? {};
  } catch {
    return null; // package.json a medio escribir (el agente sigue trabajando)
  }

  // Orden por convención: el primero que exista gana.
  const script = ["dev", "start", "serve"].find((s) => typeof scripts[s] === "string");
  if (!script) return null;

  return { command: "npm", args: ["run", script], portEnv: "PORT" };
}

/**
 * Arranca el dev server del workspace de una sala.
 *
 * Es genérico al stack: NO asume Vite. El `launch` sale de `detectLaunch`, que
 * lee lo que el proyecto declara. El motor solo "prende el server y reporta la
 * URL"; quién la muestra (iframe) es otra pieza.
 *
 * Corre como PROCESO SEPARADO (no embebido): si un preview crashea, no tumba el
 * server de Multi.
 *
 * Con `container`, el dev server corre ADENTRO del contenedor de la sala y se
 * llega a él por el puerto que Docker publicó en el host. La URL que se reporta
 * es de host en los dos casos, así que el proxy no se entera de la diferencia.
 */
export async function startPreview(
  workspace: Workspace,
  launch: Launch,
  container?: { roomId: string; internalPort: number; publishedPort: number },
): Promise<Preview> {
  // Dentro del contenedor el puerto lo fija el contenedor; fuera, lo elegimos.
  const port = container ? container.publishedPort : await nextPort();
  const { command, args, portEnv } = launch;

  const child = container
    ? spawnInContainer(
        container.roomId,
        [command, ...args].join(" "),
        portEnv ? { [portEnv]: String(container.internalPort) } : {},
      )
    : spawn(command, args, {
        cwd: workspace.dir,
        env: { ...process.env, ...(portEnv ? { [portEnv]: String(port) } : {}) },
        // stdout/stderr capturados para logs y para detectar arranque; sin shell.
        stdio: ["ignore", "pipe", "pipe"],
      });

  const tag = `[preview ${workspace.roomId}:${port}]`;
  child.stdout?.on("data", (d) => process.stdout.write(`${tag} ${d}`));
  child.stderr?.on("data", (d) => process.stderr.write(`${tag} ${d}`));

  const url = `http://localhost:${port}`;

  const stop = async (): Promise<void> => {
    // En contenedor el puerto lo administra Docker, no nuestro registro.
    if (!container) usedPorts.delete(port);
    if (child.killed) return;
    child.kill("SIGTERM");
    // Gracia breve; si no muere, SIGKILL.
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 3000);
      child.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  };

  // Si el proceso muere solo (crash de install/dev), liberar el puerto.
  child.once("exit", (code) => {
    if (!container) usedPorts.delete(port);
    process.stdout.write(`${tag} proceso terminó (code ${code})\n`);
  });

  // Esperar a que el dev server acepte conexiones antes de reportar.
  //
  // El tope es generoso a propósito: sobre /mnt/c en WSL, Vite puede tardar más
  // de un minuto solo en arrancar (Windows traduciendo miles de lecturas de
  // node_modules). Con un tope corto el proceso se quedaba vivo pero sin
  // registrar — un dev server huérfano y un preview que nunca aparecía.
  try {
    await waitForPort(port, { timeoutMs: 300_000, child, container: !!container });
  } catch (err) {
    // Si no llegó a escuchar, no dejar el proceso suelto ocupando el puerto.
    await stop();
    throw err;
  }

  return { roomId: workspace.roomId, port, url, process: child, stop };
}

/**
 * Espera a que el dev server esté listo.
 *
 * Sin contenedor basta un connect TCP: si el puerto acepta, hay algo escuchando.
 * CON contenedor no: Docker publica el puerto en el host desde que el contenedor
 * arranca, así que el connect funciona aunque adentro no haya nada todavía. Por
 * eso ahí se pide una respuesta HTTP de verdad.
 */
function waitForPort(
  port: number,
  opts: { timeoutMs: number; child: ChildProcess; container?: boolean },
): Promise<void> {
  const { timeoutMs, child, container } = opts;
  const deadline = Date.now() + timeoutMs;

  if (container) return waitForHttp(port, deadline, child);

  return new Promise((resolve, reject) => {
    let settled = false;

    // Si el proceso muere antes de escuchar, fallar rápido.
    const onExit = (code: number | null) => {
      if (settled) return;
      settled = true;
      reject(new Error(`dev server terminó antes de escuchar (code ${code})`));
    };
    child.once("exit", onExit);

    const attempt = () => {
      if (settled) return;
      const sock = createConnection({ port, host: "127.0.0.1" });
      sock.once("connect", () => {
        sock.destroy();
        if (settled) return;
        settled = true;
        child.off("exit", onExit);
        resolve();
      });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() > deadline) {
          if (settled) return;
          settled = true;
          child.off("exit", onExit);
          reject(new Error(`timeout esperando el dev server en :${port}`));
          return;
        }
        setTimeout(attempt, 400);
      });
    };
    attempt();
  });
}

/**
 * Sondea con una petición HTTP real, para contenedores.
 *
 * El puerto publicado por Docker acepta conexiones desde el arranque del
 * contenedor, así que un connect TCP no dice nada: hay que ver si algo del otro
 * lado contesta HTTP. Un 404 o un 500 también valen — significa que el dev
 * server está vivo, aunque esa ruta no exista.
 */
async function waitForHttp(
  port: number,
  deadline: number,
  child: ChildProcess,
): Promise<void> {
  let murio: number | null | undefined;
  child.once("exit", (code) => (murio = code));

  for (;;) {
    if (murio !== undefined) {
      throw new Error(`dev server terminó antes de responder (code ${murio})`);
    }
    if (Date.now() > deadline) {
      throw new Error(`timeout esperando el dev server en :${port}`);
    }

    try {
      await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(4000),
      });
      return; // cualquier respuesta HTTP significa que ya está sirviendo
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
