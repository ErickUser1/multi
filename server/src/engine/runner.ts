import { spawn } from "node:child_process";
import { execInContainer, type ExecResult } from "./container.js";

/**
 * Quién ejecuta los comandos del agente.
 *
 * Dos brazos con la misma forma: adentro del contenedor de la sala (el normal)
 * o directo en la máquina (cuando no hay Docker). La tool de bash no sabe cuál
 * le tocó — solo pide "corre esto".
 */
export interface Runner {
  readonly isolated: boolean;
  exec(command: string, opts: { timeoutMs: number; maxOutput: number }): Promise<ExecResult>;
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
 * del workspace. No es un descuido de esta función — es el límite de lo que se
 * puede hacer sin ayuda del sistema operativo, y la razón de que exista el
 * contenedor. Se usa solo cuando no hay Docker, y el server lo avisa al arrancar.
 */
export function localRunner(workspaceDir: string): Runner {
  return {
    isolated: false,
    exec(command, opts) {
      return new Promise((resolve, reject) => {
        const child = spawn(command, { cwd: workspaceDir, shell: true, env: process.env });

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
