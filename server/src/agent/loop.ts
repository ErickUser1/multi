import {
  type ModelProvider,
  type Message,
  type ContentBlock,
  type StreamCallbacks,
} from "./providers/types.js";
import { toolRegistry, toolSpecs, type ToolContext, type ToolEvent, ToolError } from "./tools/index.js";

const MAX_TURNS = 50;

const SYSTEM_PROMPT = `Eres un agente de código dentro de "Multi", una sala donde se construyen apps en vivo.
Trabajas sobre el workspace de la sala usando tus tools. Reglas:
- Para ver código usa read_file/grep/glob. Para cambiarlo usa write_file/edit_file (NUNCA edites con bash).
- Usa bash solo para procesos: instalar deps, git, builds.
- Haz cambios mínimos y precisos. No expliques de más: actúa.
- Cuando termines la tarea, responde brevemente qué hiciste.`;

export interface AgentCallbacks extends StreamCallbacks {
  /** El agente va a ejecutar una tool (nombre + input). */
  onToolStart?: (info: { id: string; name: string; input: Record<string, unknown> }) => void;
  /** La tool terminó (resultado o error). */
  onToolEnd?: (info: { id: string; name: string; result: string; isError: boolean }) => void;
  /** Gate de permisos: retorna false para BLOQUEAR la tool antes de ejecutarla. */
  shouldAllowTool?: (name: string, input: Record<string, unknown>) => boolean | Promise<boolean>;
  /** Eventos observables de las tools (file:changed, etc.) → socket. */
  onToolEvent?: (event: ToolEvent) => void;
}

export interface RunResult {
  /** Texto final del assistant (lo que respondió al terminar). */
  finalText: string;
  /** Turnos usados. */
  turns: number;
  /** Historial completo tras la corrida (para persistir/continuar). */
  messages: Message[];
}

/**
 * EL loop del agente. Blueprint: doc oficial de Anthropic + ~/ccx-rs.
 *
 * Ciclo: manda mensajes al modelo → si stop_reason == tool_use, ejecuta TODAS
 * las tools EN PARALELO (mejora sobre CCX que las hace en serie), mete los
 * resultados como un mensaje user, y repite. Termina en end_turn / max_turns.
 */
export async function runAgent(opts: {
  provider: ModelProvider;
  workspaceDir: string;
  /** Historial previo (para continuar una conversación) o vacío. */
  messages: Message[];
  /** El mensaje nuevo del usuario que dispara este turno. */
  userMessage: string;
  model?: string;
  maxTokens?: number;
  callbacks?: AgentCallbacks;
  signal?: AbortSignal;
  /** Quién es este agente (para el CAS y los locks). */
  agentId?: string;
  /** Avisos de espera de lock (para mostrar "esperando a X" — dos relojes). */
  onWaitStart?: (info: { path: string; holder?: string }) => void;
  onWaitEnd?: () => void;
}): Promise<RunResult> {
  const { provider, workspaceDir, userMessage, model, maxTokens, callbacks = {}, signal } = opts;

  const messages: Message[] = [
    ...opts.messages,
    { role: "user", content: [{ type: "text", text: userMessage }] },
  ];

  const toolCtx: ToolContext = {
    workspaceDir,
    emit: callbacks.onToolEvent,
    agentId: opts.agentId,
    onWaitStart: opts.onWaitStart,
    onWaitEnd: opts.onWaitEnd,
  };

  let finalText = "";
  let turn = 0;

  for (; turn < MAX_TURNS; turn++) {
    const end = await provider.stream(
      {
        system: SYSTEM_PROMPT,
        messages,
        tools: toolSpecs,
        maxTokens,
        model,
        signal,
      },
      callbacks,
    );

    // Guardar el mensaje del assistant en el historial.
    messages.push(end.message);

    // Recolectar el texto (por si es la respuesta final).
    finalText = textOf(end.message);

    if (end.stopReason !== "tool_use") {
      // end_turn / max_tokens / etc. → terminó.
      return { finalText, turns: turn + 1, messages };
    }

    // Hay tools que ejecutar. Sacar todos los tool_use del mensaje.
    const toolUses = end.message.content.filter(
      (c): c is Extract<ContentBlock, { type: "tool_use" }> => c.type === "tool_use",
    );

    // Ejecutar TODAS en paralelo. Cada una produce un tool_result.
    const results = await Promise.all(
      toolUses.map((tu) => executeTool(tu, toolCtx, callbacks)),
    );

    // Los resultados van como UN mensaje user con todos los tool_result.
    messages.push({ role: "user", content: results });
  }

  // Se acabaron los turnos.
  return { finalText: finalText || "(el agente alcanzó el límite de turnos)", turns: turn, messages };
}

/** Ejecuta un tool_use (con gate de permisos) → tool_result. */
async function executeTool(
  tu: Extract<ContentBlock, { type: "tool_use" }>,
  ctx: ToolContext,
  callbacks: AgentCallbacks,
): Promise<Extract<ContentBlock, { type: "tool_result" }>> {
  callbacks.onToolStart?.({ id: tu.id, name: tu.name, input: tu.input });

  const emit = (result: string, isError: boolean): Extract<ContentBlock, { type: "tool_result" }> => {
    callbacks.onToolEnd?.({ id: tu.id, name: tu.name, result, isError });
    return { type: "tool_result", tool_use_id: tu.id, content: result, is_error: isError };
  };

  // Gate de permisos.
  if (callbacks.shouldAllowTool) {
    const allowed = await callbacks.shouldAllowTool(tu.name, tu.input);
    if (!allowed) return emit(`bloqueado: no se permitió ejecutar "${tu.name}"`, true);
  }

  const tool = toolRegistry.get(tu.name);
  if (!tool) return emit(`tool desconocida: ${tu.name}`, true);

  try {
    const result = await tool.run(tu.input, ctx);
    return emit(result, false);
  } catch (err) {
    const msg = err instanceof ToolError ? err.message : `error inesperado: ${String(err)}`;
    return emit(msg, true);
  }
}

function textOf(message: Message): string {
  return message.content
    .filter((c): c is Extract<ContentBlock, { type: "text" }> => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();
}
