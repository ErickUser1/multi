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
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
  /**
   * Una imagen que alguien pegó en el chat. Solo se manda a proveedores que ven
   * (ver `ve` en profiles.ts); a los demás les llega la ruta como texto y con eso
   * les basta para meterla en la app.
   *
   * `data` es base64 pelón, sin el prefijo `data:`. Cada proveedor lo envuelve a
   * su manera: Anthropic quiere `source.base64`, los de formato OpenAI quieren un
   * data URI completo.
   *
   * Va ANTES del bloque de texto dentro del mensaje. Las dos documentaciones
   * oficiales dicen lo mismo: el modelo responde mejor viendo la imagen primero
   * y la pregunta después.
   */
  | { type: "image"; mediaType: string; data: string }
  /**
   * Un documento (hoy PDF) que alguien adjuntó al chat.
   *
   * Va aparte de `image` porque la API lo recibe distinto: Anthropic quiere un
   * bloque `document`, no uno de imagen, y lo lee entero del lado suyo — no hay
   * que extraerle el texto aquí.
   *
   * Los proveedores de formato OpenAI no lo aceptan igual, así que ahí se
   * descarta. El agente igual ve el nombre en el texto del mensaje y puede
   * meterlo al proyecto con `usar_adjunto`.
   */
  | { type: "documento"; mediaType: string; data: string }
  /**
   * Un bloque de Anthropic tal como llegó, para regresarlo idéntico.
   *
   * Son los de las herramientas que corren del lado de Anthropic (buscar y leer
   * páginas): `server_tool_use`, `web_search_tool_result`, `web_fetch_tool_result`
   * y los de código del filtrado. La API pide que vuelvan sin tocar un byte
   * (traen `encrypted_content`) y si no, es un 400. Guardarlos crudos en vez de
   * modelar cada uno hace que un tipo nuevo que saquen tampoco rompa nada.
   *
   * Solo los entiende Anthropic: los demás proveedores los ignoran.
   */
  | { type: "crudo"; bloque: Record<string, unknown> };

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
      /**
       * El tope de salida cortó una herramienta a media escritura y se
       * descartó. Distingue "se le acabó el espacio escribiendo" de "se le
       * acabó pensando": lo primero sí se arregla con más espacio.
       */
      herramientaCortada?: boolean;
      /** La ruta del archivo que se cortó, si se alcanzó a leer. Va en el aviso. */
      archivoCortado?: string;
      /** Ids de tool_use cuyo input no era JSON válido: se contestan con error. */
      inputsInvalidos?: string[];
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
  /** Búsquedas en internet de la vuelta (cada una se cobra aparte). */
  busquedas?: number;
  /** Páginas leídas de internet en la vuelta. */
  lecturas?: number;
}

// ── Callbacks del stream (para reaccionar en vivo) ─────────────────────────

export interface StreamCallbacks {
  /** Texto del assistant llegando token por token (→ chat en vivo). */
  onText?: (delta: string) => void;
  /** Pensamiento (si el modelo lo emite). */
  onThinking?: (delta: string) => void;
  /** Aviso de reintento tras rate-limit / overload. */
  onRetry?: (info: { attempt: number; waitMs: number; reason: string }) => void;
  /**
   * El modelo usó una herramienta que corre del lado del proveedor (buscar o
   * leer una página). No hay nada que ejecutar: es para enseñarlo en la sala.
   */
  onServerTool?: (info: { id: string; name: string; input: Record<string, unknown> }) => void;
  /**
   * Una herramienta empezó a escribirse y ya se sabe a qué archivo va, aunque
   * sus argumentos sigan llegando. Un archivo grande tarda minutos en llegar
   * completo: sin esto la sala no enseñaba nada en todo ese rato.
   */
  onToolPreparing?: (info: { id: string; name: string; input: Record<string, unknown> }) => void;
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
