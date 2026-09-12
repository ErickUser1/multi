import { spawn } from "node:child_process";
import { execInContainer, type ExecResult } from "./container.js";

/**
 * Quién ejecuta los comandos del agente.
 *
 * Dos brazos con la misma forma: adentro del contenedor de la sala (el normal)
 * o directo en la máquina (cuando no hay Docker). La tool de bash no sabe cuál
 * le tocó — solo pide "corre esto".
 */
/**
 * No se pudo aislar la sala, así que no va a ejecutar nada.
 *
 * Es un tipo propio y no un Error cualquiera porque arriba hay que distinguirlo
 * de "falló el proyecto": al agente y a quien está en la sala se les dice cosas
 * muy distintas. Ir por el tipo y no por el texto deja cambiar los mensajes sin
 * romper esa traducción.
 */
export class NoHayAislamiento extends Error {}

export interface Runner {
  readonly isolated: boolean;
  exec(
    command: string,
    opts: {
      timeoutMs: number;
      maxOutput: number;
      /**
       * Variables solo para este comando. Las usa el deploy para pasarle el
       * token de la plataforma a `wrangler` sin dejarlo en ningún lado.
       */
      env?: Record<string, string>;
    },
  ): Promise<ExecResult>;
}

/** El normal: el comando corre encerrado en el contenedor de la sala. */
export function containerRunner(roomId: string): Runner {
  return {
    isolated: true,
    exec: (command, opts) => execInContainer(roomId, command, opts),
  };
}

/**
 * El de respaldo: el comando corre en la máquina donde vive el server.
 *
 * `cwd` acota dónde EMPIEZA el comando, no hasta dónde llega: un `cd ..` sale
 * del workspace. No es un descuido de esta función, es el límite de lo que se
 * puede hacer sin ayuda del sistema operativo, y la razón de que exista el
 * contenedor.
 *
 * Solo se llega aquí por dos caminos, los dos deliberados: que no haya Docker en
 * la máquina, o que alguien haya puesto MULTI_SIN_AISLAMIENTO=1. Nunca porque
 * algo falló. Antes sí: cuando `docker run` tronaba, la sala caía aquí sola y lo
 * decía en un `console.error` que nadie lee. En un experimento con 11 personas
 * eso significó 62 salas ejecutando como root en el servidor, y a nadie le
 * constó hasta dos días después.
 */
export function localRunner(workspaceDir: string): Runner {
  return {
    isolated: false,
    exec(command, opts) {
      return new Promise((resolve, reject) => {
        const child = spawn(command, {
          cwd: workspaceDir,
          shell: true,
          env: { ...process.env, ...opts.env },
        });

        let stdout = "";
        let stderr = "";
        let timedOut = false;

        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, opts.timeoutMs);

        child.stdout?.on("data", (d) => {
          if (stdout.length < opts.maxOutput) stdout += d.toString();
        });
        child.stderr?.on("data", (d) => {
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
    },
  };
}
