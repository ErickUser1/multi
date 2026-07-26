import { spawn } from "node:child_process";
import { type Tool, ToolError, reqString } from "./base.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 30_000; // truncar salidas enormes para no reventar el contexto

/**
 * Bash — ejecuta comandos de shell DENTRO del workspace de la sala.
 * Para procesos: npm install, git, arrancar builds. NO para editar archivos
 * (eso va por edit_file, que es preciso y observable).
 *
 * cwd fijado al workspace: los comandos corren scoped a la sala.
 */
export const bashTool: Tool = {
  spec: {
    name: "bash",
    description:
      "Ejecuta un comando de shell en el workspace de la sala (ej. npm install, git status). Úsalo para procesos, NO para editar archivos.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Comando de shell a ejecutar" },
        timeout_ms: { type: "number", description: "Timeout en ms (default 120000)" },
      },
      required: ["command"],
    },
  },
  async run(input, ctx) {
    const command = reqString(input, "command");
    const timeoutMs = typeof input.timeout_ms === "number" ? input.timeout_ms : DEFAULT_TIMEOUT_MS;

    ctx.emit?.({ type: "tool:bash", command });

    return new Promise<string>((resolve, reject) => {
      // shell:true para soportar pipes/&&; cwd fijo al workspace.
      const child = spawn(command, {
        cwd: ctx.workspaceDir,
        shell: true,
        env: process.env,
      });

      let stdout = "";
      let stderr = "";
      let killed = false;

      const timer = setTimeout(() => {
        killed = true;
        child.kill("SIGKILL");
      }, timeoutMs);

      child.stdout?.on("data", (d) => {
        if (stdout.length < MAX_OUTPUT) stdout += d.toString();
      });
      child.stderr?.on("data", (d) => {
        if (stderr.length < MAX_OUTPUT) stderr += d.toString();
      });

      child.once("error", (err) => {
        clearTimeout(timer);
        reject(new ToolError(`no se pudo ejecutar el comando: ${String(err)}`));
      });

      child.once("exit", (code) => {
        clearTimeout(timer);
        if (killed) {
          reject(new ToolError(`comando excedió el timeout de ${timeoutMs}ms`));
          return;
        }
        const out = truncate(stdout);
        const err = truncate(stderr);
        const parts: string[] = [];
        if (out) parts.push(out);
        if (err) parts.push(`[stderr]\n${err}`);
        parts.push(`[exit code: ${code}]`);
        // Un exit != 0 NO es un throw: el modelo debe ver el error y decidir.
        resolve(parts.join("\n"));
      });
    });
  },
};

function truncate(s: string): string {
  const t = s.trimEnd();
  return t.length > MAX_OUTPUT ? `${t.slice(0, MAX_OUTPUT)}\n…(truncado)` : t;
}
