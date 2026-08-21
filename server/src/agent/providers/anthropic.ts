import {
  type ModelProvider,
  type StreamParams,
  type StreamCallbacks,
  type StreamEvent,
  type Message,
  type ContentBlock,
  type StopReason,
  ProviderError,
} from "./types.js";

const API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
// Sonnet en vez de Opus a propósito. Una sala de Multi es un loop agéntico: cada
// turno reenvía el historial completo, y con Opus una sesión de dos horas se come
// el saldo de una semana (pasó, 17 dólares en una tarde). Sonnet hace igual de
// bien lo que se pide aquí (scaffoldear, editar, rediseñar) por menos de la mitad.
// Quien quiera Opus lo pone en MULTI_MODEL o desde la Sala.
const DEFAULT_MODEL = "claude-sonnet-5";
const DEFAULT_MAX_TOKENS = 8192;

// Retry: 429 (rate limit) y 529 (overloaded). Config estilo CCX.
const RETRY = { maxRetries: 5, baseMs: 1000, capMs: 60_000 };

/**
 * Proveedor Claude — cliente HTTP directo a la API de Mensajes de Anthropic.
 * Sin SDK. Parsea el stream SSE a mano y lo traduce a StreamEvent neutrales.
 *
 * Referencias: doc oficial (formato SSE, modelo claude-opus-5, headers) +
 * ~/ccx-rs/research-api-core.md (estructura de eventos, errores, retry).
 */
export class AnthropicProvider implements ModelProvider {
  readonly name = "anthropic";
  readonly defaultModel = DEFAULT_MODEL;

  constructor(private readonly apiKey: string) {
    if (!apiKey) throw new ProviderError("falta ANTHROPIC_API_KEY", "auth");
  }

  async stream(
    params: StreamParams,
    callbacks: StreamCallbacks = {},
  ): Promise<Extract<StreamEvent, { type: "end" }>> {
    let attempt = 0;
    // Reintentos sobre errores retryables (rate_limit / overloaded / network).
    for (;;) {
      try {
        return await this.streamOnce(params, callbacks);
      } catch (err) {
        const pe = err instanceof ProviderError ? err : new ProviderError(String(err), "network", { cause: err });
        if (!pe.retryable || attempt >= RETRY.maxRetries) throw pe;
        attempt++;
        const waitMs = pe.opts.retryAfterMs ?? backoff(attempt);
        callbacks.onRetry?.({ attempt, waitMs, reason: pe.kind });
        await sleep(waitMs);
      }
    }
  }

  private async streamOnce(
    params: StreamParams,
    callbacks: StreamCallbacks,
  ): Promise<Extract<StreamEvent, { type: "end" }>> {
    const body = buildRequestBody(params, this.defaultModel);

    let res: Response;
    try {
      res = await fetch(API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
        signal: params.signal,
      });
    } catch (err) {
      throw new ProviderError("fallo de red al llamar la API", "network", { cause: err });
    }

    if (!res.ok) throw await httpError(res);
    if (!res.body) throw new ProviderError("respuesta sin body", "api", { status: res.status });

    return this.consumeStream(res.body, callbacks);
  }

  /** Lee el stream SSE byte a byte, reensambla bloques, emite el evento `end`. */
  private async consumeStream(
    body: ReadableStream<Uint8Array>,
    callbacks: StreamCallbacks,
  ): Promise<Extract<StreamEvent, { type: "end" }>> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // Estado acumulado del mensaje que se está construyendo.
    const acc = new MessageAccumulator();

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Los eventos SSE se separan por línea en blanco (\n\n).
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const rawEvent = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          this.handleSseBlock(rawEvent, acc, callbacks);
        }
      }
    } catch (err) {
      throw new ProviderError("error leyendo el stream", "network", { cause: err });
    } finally {
      reader.releaseLock();
    }

    // El stream terminó. acc ya vio message_delta (stop_reason) y message_stop.
    if (!acc.stopReason) {
      throw new ProviderError("el stream terminó sin stop_reason", "parse");
    }

    return {
      type: "end",
      stopReason: acc.stopReason,
      message: acc.buildMessage(),
      usage: acc.usage,
    };
  }

  /**
   * Procesa un bloque SSE ("event: X\ndata: {...}"). Enruta por el campo `type`
   * del JSON (no por la línea `event:`), como CCX — más robusto a cambios.
   */
  private handleSseBlock(rawEvent: string, acc: MessageAccumulator, callbacks: StreamCallbacks): void {
    // Un bloque puede tener varias líneas; nos quedamos con la(s) de data:.
    const dataLines = rawEvent
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim());
    if (dataLines.length === 0) return;

    const dataStr = dataLines.join("\n");
    let data: any;
    try {
      data = JSON.parse(dataStr);
    } catch {
      throw new ProviderError(`SSE data no es JSON válido: ${dataStr.slice(0, 120)}`, "parse");
    }

    switch (data.type) {
      case "message_start":
        acc.onMessageStart(data.message);
        break;

      case "content_block_start":
        acc.onBlockStart(data.index, data.content_block);
        break;

      case "content_block_delta":
        acc.onBlockDelta(data.index, data.delta, callbacks);
        break;

      case "content_block_stop":
        acc.onBlockStop(data.index);
        break;

      case "message_delta":
        acc.onMessageDelta(data.delta, data.usage);
        break;

      case "message_stop":
        // fin natural del stream; nada que hacer, el loop de lectura termina.
        break;

      case "ping":
        break;

      case "error": {
        // Error dentro del stream (ej. overloaded a mitad de respuesta).
        const kind = data.error?.type === "overloaded_error" ? "overloaded" : "api";
        throw new ProviderError(data.error?.message ?? "error en el stream", kind);
      }

      default:
        // Tipo desconocido: ignorar (política oficial de forward-compat).
        break;
    }
  }
}

// ── Acumulador de mensaje ───────────────────────────────────────────────────

/**
 * Reensambla el mensaje del assistant desde los eventos SSE.
 * Los tool_use llegan como JSON parcial (input_json_delta) que se concatena
 * y se parsea al content_block_stop.
 */
class MessageAccumulator {
  stopReason: StopReason | null = null;
  usage: Extract<StreamEvent, { type: "end" }>["usage"];

  // Bloques por índice, en construcción.
  private blocks = new Map<
    number,
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; jsonBuf: string }
    | { type: "thinking"; text: string }
  >();

  onMessageStart(message: any): void {
    if (message?.usage) {
      this.usage = {
        inputTokens: message.usage.input_tokens ?? 0,
        outputTokens: message.usage.output_tokens ?? 0,
        cacheReadTokens: message.usage.cache_read_input_tokens,
        cacheCreationTokens: message.usage.cache_creation_input_tokens,
      };
    }
  }

  onBlockStart(index: number, cb: any): void {
    if (cb.type === "text") {
      this.blocks.set(index, { type: "text", text: cb.text ?? "" });
    } else if (cb.type === "tool_use") {
      this.blocks.set(index, { type: "tool_use", id: cb.id, name: cb.name, jsonBuf: "" });
    } else if (cb.type === "thinking") {
      this.blocks.set(index, { type: "thinking", text: cb.thinking ?? "" });
    }
    // otros tipos (server_tool_use, etc.) no aplican a nuestro caso: se ignoran.
  }

  onBlockDelta(index: number, delta: any, callbacks: StreamCallbacks): void {
    const block = this.blocks.get(index);
    if (!block) return;

    switch (delta.type) {
      case "text_delta":
        if (block.type === "text") {
          block.text += delta.text;
          callbacks.onText?.(delta.text);
        }
        break;
      case "input_json_delta":
        if (block.type === "tool_use") {
          block.jsonBuf += delta.partial_json ?? "";
        }
        break;
      case "thinking_delta":
        if (block.type === "thinking") {
          block.text += delta.thinking;
          callbacks.onThinking?.(delta.thinking);
        }
        break;
      // signature_delta: no lo necesitamos (integridad del thinking), se ignora.
    }
  }

  onBlockStop(_index: number): void {
    // El input del tool_use ya está completo en jsonBuf; se parsea en buildMessage.
  }

  onMessageDelta(delta: any, usage: any): void {
    if (delta?.stop_reason) this.stopReason = delta.stop_reason as StopReason;
    // usage en message_delta es acumulativo (output_tokens final).
    if (usage && this.usage) {
      this.usage.outputTokens = usage.output_tokens ?? this.usage.outputTokens;
    }
  }

  /** Construye el Message neutral, parseando los inputs de tool_use. */
  buildMessage(): Message {
    const content: ContentBlock[] = [];
    // Orden por índice para respetar el orden original.
    const indices = [...this.blocks.keys()].sort((a, b) => a - b);
    for (const i of indices) {
      const b = this.blocks.get(i)!;
      if (b.type === "text") {
        if (b.text.length) content.push({ type: "text", text: b.text });
      } else if (b.type === "tool_use") {
        let input: Record<string, unknown> = {};
        const raw = b.jsonBuf.trim();
        if (raw.length) {
          try {
            input = JSON.parse(raw);
          } catch {
            // Casi siempre es un stream que se cortó a media generación: el JSON
            // llega truncado, sin cerrar. Pasó de verdad cuando se acabaron los
            // créditos mientras el modelo escribía los argumentos. El mensaje lo
            // dice, porque "JSON inválido" a secas no le sirve a nadie en la sala.
            const truncado = !raw.endsWith("}");
            throw new ProviderError(
              truncado
                ? `la respuesta del modelo se cortó a media escritura (tool "${b.name}"). Suele pasar si se acaban los créditos o se pierde la conexión.`
                : `input de tool_use "${b.name}" no es JSON válido: ${raw.slice(0, 120)}`,
              "parse",
            );
          }
        }
        content.push({ type: "tool_use", id: b.id, name: b.name, input });
      }
      // thinking no se reenvía al historial en v1 (se muestra en vivo y ya).
    }
    return { role: "assistant", content };
  }
}

// ── Construcción del request ────────────────────────────────────────────────

function buildRequestBody(params: StreamParams, defaultModel: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: params.model ?? defaultModel,
    max_tokens: params.maxTokens ?? DEFAULT_MAX_TOKENS,
    stream: true,
    messages: params.messages.map(toApiMessage),
    // Cachea el ÚLTIMO bloque cacheable del request, que en un loop agéntico es
    // el final del historial. Sin esto solo se cacheaba el system: cada vuelta
    // reenviaba a precio completo todo lo que el agente ya había leído y escrito,
    // y un turno largo son quince o veinte vueltas sobre el mismo historial que
    // solo crece. Lo que se relee sale a una décima parte.
    //
    // La forma automática y no marcar bloque por bloque: el caché es un prefix
    // match, así que un breakpoint mal puesto no da error, simplemente deja de
    // acertar y nadie se entera. Aquí el prefijo estable (tools, system, y el
    // historial hasta la vuelta anterior) queda antes por construcción.
    cache_control: { type: "ephemeral" },
  };

  // system como array con cache_control → activa prompt caching en el prompt de sistema.
  // (gap que CCX no cubría; nosotros sí.)
  if (params.system) {
    body.system = [{ type: "text", text: params.system, cache_control: { type: "ephemeral" } }];
  }

  if (params.tools?.length) {
    body.tools = params.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));
  }

  return body;
}

/** Traduce un Message neutral al formato de content blocks de la API. */
function toApiMessage(m: Message): Record<string, unknown> {
  return {
    role: m.role,
    content: m.content.map((block) => {
      switch (block.type) {
        case "text":
          return { type: "text", text: block.text };
        case "tool_use":
          return { type: "tool_use", id: block.id, name: block.name, input: block.input };
        case "tool_result":
          return {
            type: "tool_result",
            tool_use_id: block.tool_use_id,
            content: block.content,
            ...(block.is_error ? { is_error: true } : {}),
          };
        case "image":
          return {
            type: "image",
            source: { type: "base64", media_type: block.mediaType, data: block.data },
          };
      }
    }),
  };
}

// ── Errores HTTP ────────────────────────────────────────────────────────────

async function httpError(res: Response): Promise<ProviderError> {
  const bodyText = await res.text().catch(() => "");
  switch (res.status) {
    case 401:
      return new ProviderError("API key inválida (401)", "auth", { status: 401 });
    case 400:
      return new ProviderError(`request inválido (400): ${bodyText.slice(0, 200)}`, "bad_request", { status: 400 });
    case 429: {
      const retryAfter = res.headers.get("retry-after");
      const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : undefined;
      return new ProviderError("rate limit (429)", "rate_limit", { status: 429, retryAfterMs });
    }
    case 529:
      return new ProviderError("API sobrecargada (529)", "overloaded", { status: 529 });
    default:
      return new ProviderError(`error de API (${res.status}): ${bodyText.slice(0, 200)}`, "api", { status: res.status });
  }
}

// ── Utilidades de retry ─────────────────────────────────────────────────────

function backoff(attempt: number): number {
  // Exponencial con tope y jitter.
  const exp = Math.min(RETRY.baseMs * 2 ** (attempt - 1), RETRY.capMs);
  return exp + Math.random() * 250;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
