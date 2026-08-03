/**
 * Contrato común de proveedores de modelo (Claude / GPT / Gemini).
 * El loop del agente habla SOLO con esta interfaz; cada proveedor traduce
 * su formato propio (SSE de Anthropic, de OpenAI, etc.) a estos tipos.
 */

// ── Mensajes de la conversación ───────────────────────────────────────────

export type Role = "user" | "assistant";

/** Bloque de contenido dentro de un mensaje (formato neutral). */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface Message {
  role: Role;
  content: ContentBlock[];
}

// ── Definición de tools (lo que se le ofrece al modelo) ────────────────────

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema del input (mismo shape que espera Anthropic en input_schema). */
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// ── Eventos que emite el stream (formato neutral) ──────────────────────────

/**
 * El proveedor emite estos eventos mientras llega la respuesta.
 * El loop los consume para: streamear texto al chat, detectar tool_use,
 * y saber cómo terminó el turno.
 */
export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  /** Un tool_use completo, ya con su input parseado (el proveedor lo reensambla). */
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  /** Fin del turno: por qué paró y el contenido completo del mensaje del assistant. */
  | {
      type: "end";
      stopReason: StopReason;
      /** El mensaje completo del assistant (texto + tool_use), para el historial. */
      message: Message;
      usage?: Usage;
    };

export type StopReason =
  | "end_turn" // terminó de hablar, sin tools pendientes
  | "tool_use" // pidió ejecutar tools
  | "max_tokens" // se cortó por límite de tokens
  | "stop_sequence"
  | "pause_turn" // (algunos modelos) pausa para retomar
  | "refusal";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

// ── Callbacks del stream (para reaccionar en vivo) ─────────────────────────

export interface StreamCallbacks {
  /** Texto del assistant llegando token por token (→ chat en vivo). */
  onText?: (delta: string) => void;
  /** Pensamiento (si el modelo lo emite). */
  onThinking?: (delta: string) => void;
  /** Aviso de reintento tras rate-limit / overload. */
  onRetry?: (info: { attempt: number; waitMs: number; reason: string }) => void;
}

// ── La interfaz del proveedor ──────────────────────────────────────────────

export interface StreamParams {
  system?: string;
  messages: Message[];
  tools?: ToolSpec[];
  maxTokens?: number;
  model?: string;
  signal?: AbortSignal;
}

export interface ModelProvider {
  readonly name: string;
  /** Modelo por defecto de este proveedor. */
  readonly defaultModel: string;
  /**
   * Manda la conversación al modelo y streamea la respuesta.
   * Invoca los callbacks en vivo y devuelve el evento `end` final.
   */
  stream(params: StreamParams, callbacks?: StreamCallbacks): Promise<Extract<StreamEvent, { type: "end" }>>;
}

// ── Errores tipados (para retry y manejo en el loop) ───────────────────────

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind:
      | "auth" // 401 — key mala
      | "rate_limit" // 429
      | "overloaded" // 529
      | "bad_request" // 400 — request mal armado
      | "presupuesto" // 402 con saldo: el techo pedido no cabe, cabe uno menor
      | "api" // otro non-2xx
      | "network" // fallo de transporte
      | "parse", // SSE malformado
    readonly opts: {
      status?: number;
      retryAfterMs?: number;
      cause?: unknown;
      /** Techo de salida que el proveedor sí acepta con el saldo de esta key. */
      maxTokensSugerido?: number;
    } = {},
  ) {
    super(message);
    this.name = "ProviderError";
  }

  get retryable(): boolean {
    return this.kind === "rate_limit" || this.kind === "overloaded" || this.kind === "network";
  }
}
