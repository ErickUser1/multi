import { type Tool, ToolError, reqString } from "./base.js";
import { localRunner } from "../../engine/runner.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 30_000; // truncar salidas enormes para no reventar el contexto

/**
 * Bash — ejecuta comandos de shell en el entorno de la sala.
 * Para procesos: npm install, git, arrancar builds. NO para editar archivos
 * (eso va por edit_file, que es preciso y observable).
 *
 * Dónde corre lo decide el `runner` del contexto: normalmente el contenedor de
 * la sala; sin Docker, la máquina del server. Aquí no se distingue — de eso se
 * trata la interfaz.
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

    const runner = ctx.runner ?? localRunner(ctx.workspaceDir);

    let result;
    try {
      result = await runner.exec(command, { timeoutMs, maxOutput: MAX_OUTPUT });
    } catch (err) {
      throw new ToolError(`no se pudo ejecutar el comando: ${String(err)}`);
    }

    if (result.timedOut) {
      throw new ToolError(`comando excedió el timeout de ${timeoutMs}ms`);
    }

    const out = truncate(result.stdout);
    const err = truncate(result.stderr);
    const parts: string[] = [];
    if (out) parts.push(out);
    if (err) parts.push(`[stderr]\n${err}`);
    parts.push(`[exit code: ${result.code}]`);
    // Un exit != 0 NO es un throw: el modelo debe ver el error y decidir.
    return parts.join("\n");
  },
};

function truncate(s: string): string {
  const t = s.trimEnd();
  return t.length > MAX_OUTPUT ? `${t.slice(0, MAX_OUTPUT)}\n…(truncado)` : t;
}
