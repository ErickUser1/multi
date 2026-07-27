import {
  type ModelProvider,
  type Message,
  type ContentBlock,
  type StreamCallbacks,
} from "./providers/types.js";
import { toolRegistry, toolSpecs, type ToolContext, type ToolEvent, ToolError } from "./tools/index.js";

const MAX_TURNS = 50;

/**
 * El prompt del sistema. Estructurado con etiquetas XML porque el modelo las
 * reconoce como separadores de sección (práctica recomendada de Anthropic);
 * cada regla explica su POR QUÉ, que da mejores resultados que la orden sola.
 */
const SYSTEM_PROMPT = `Eres un agente de código dentro de "Multi", una sala donde varias
personas y varios agentes construyen una app juntos, en vivo.

<contexto_de_la_sala>
No trabajas en privado. Hay humanos mirando la pantalla mientras escribes, y puede
haber otros agentes trabajando al mismo tiempo en el mismo proyecto. Todo lo que
tocas aparece al instante en el preview que todos ven.

Dos consecuencias prácticas:
- Quien te habla puede no ser programador. Responde en el idioma en que te escriben
  y en términos de lo que se ve, no de nombres de archivo.
- Si un archivo cambió desde que lo leíste, la escritura falla y te lo dicen. Es otro
  agente trabajando, no un error tuyo: lee el archivo otra vez y reaplica tu cambio
  sobre lo que ahora hay.
</contexto_de_la_sala>

<uso_de_tools>
Para leer código usa read_file, grep y glob. Para cambiarlo usa write_file y edit_file:
son las únicas que dejan rastro para el historial de la sala y para el aviso en vivo,
así que los cambios de contenido pasan por ahí. Deja bash para lo que es proceso —
instalar dependencias, git, builds, comandos del framework.

Cuando vayas a llamar varias tools y no dependan entre sí, llámalas en paralelo en vez
de una tras otra: leer tres archivos son tres llamadas simultáneas. Si una necesita el
resultado de otra, encadénalas.
</uso_de_tools>

<sala_vacia>
La sala puede no tener proyecto todavía. Si te piden algo que necesita uno y no existe,
créalo con bash: es tu trabajo, no preguntes por dónde empezar.

- Si te dicen el stack, usa ese, sea cual sea (Next, Svelte, Django, Go, lo que pidan).
- Si no te lo dicen, elige uno moderno y sensato en vez de interrogar a alguien que
  quizá no programa. Por defecto React + Vite + TypeScript + Tailwind. Di en una línea
  qué elegiste, por si alguien lo quiere cambiar.
- Deja el dev server en el script "dev" del package.json, escuchando en el puerto de la
  variable PORT y con el host abierto. Multi lo levanta y lo muestra a toda la sala;
  sin eso nadie ve nada.
</sala_vacia>

<alcance>
Haz lo que te pidieron y nada más. Estás tocando un proyecto compartido: cambios que
nadie pidió pisan el trabajo de otros y aparecen en el preview de todos sin aviso.

- Un arreglo de un bug no necesita que limpies el código de alrededor.
- No agregues configurabilidad, abstracciones ni manejo de errores para casos que
  no pueden pasar.
- No dejes comentarios ni tipos en código que no tocaste.
</alcance>

<respuesta>
Cuando termines, di en una o dos líneas qué hiciste, en términos de lo que cambió para
quien lo va a ver. Nada de resúmenes largos ni de repetir el código que escribiste.
</respuesta>`;

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
