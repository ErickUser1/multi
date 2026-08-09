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

/**
 * Proveedor para cualquier API que hable el formato de OpenAI.
 *
 * No es "el cliente de OpenRouter" ni "el de OpenAI": es el del FORMATO. Con la
 * URL base configurable, el mismo código sirve para OpenRouter (y por ahí,
 * Gemma, Llama, DeepSeek…), OpenAI, Groq y Ollama local. Un cliente, muchos
 * proveedores — que es lo que un proyecto open source necesita: cada quien trae
 * el modelo que puede pagar, o el que corre en su máquina.
 *
 * Traduce entre nuestro formato neutral y el suyo:
 *   nuestro tool_use    <->  su tool_calls (con arguments en JSON string)
 *   nuestro tool_result <->  su mensaje role:"tool"
 *
 * Referencia: doc de streaming de OpenAI (los chunks llegan como SSE con
 * `data:`, terminan en `[DONE]`, el texto se concatena y los tool_calls se
 * acumulan POR ÍNDICE — un mismo tool call llega partido en varios chunks).
 */

const RETRY = { maxRetries: 5, baseMs: 1000, capMs: 60_000 };

/** Techo de salida por defecto cuando nadie pide uno. */
const DEFAULT_MAX_TOKENS = 8192;

/**
 * Piso al recortar el techo por falta de saldo. Por debajo de esto el modelo se
 * corta a media llamada de herramienta y devuelve un JSON truncado: parece un
 * bug del agente cuando en realidad es que no alcanza el dinero.
 */
const MIN_MAX_TOKENS = 512;

export interface OpenAICompatOptions {
  apiKey: string;
  /** Sin barra final. Ej: https://openrouter.ai/api/v1 */
  baseUrl: string;
  defaultModel: string;
  /** Nombre para logs y para que la UI diga con quién está hablando. */
  name: string;
  /** Cabeceras extra (OpenRouter pide identificar la app). */
  extraHeaders?: Record<string, string>;
}

export class OpenAICompatProvider implements ModelProvider {
  readonly name: string;
  readonly defaultModel: string;

  constructor(private readonly opts: OpenAICompatOptions) {
    if (!opts.apiKey) throw new ProviderError(`falta la API key de ${opts.name}`, "auth");
    this.name = opts.name;
    this.defaultModel = opts.defaultModel;
  }

  async stream(
    params: StreamParams,
    callbacks: StreamCallbacks = {},
  ): Promise<Extract<StreamEvent, { type: "end" }>> {
    let attempt = 0;
    // El techo de salida puede bajar entre intentos: ver el catch de abajo.
    let enCurso = params;

    for (;;) {
      try {
        return await this.once(enCurso, callbacks);
      } catch (err) {
        const e = err as ProviderError;
        if (!(e instanceof ProviderError)) throw err;

        // Techo demasiado alto para el saldo de la key. Esperar no sirve de
        // nada aquí — el saldo no crece solo — así que se reintenta YA con el
        // número que el proveedor dijo que sí acepta, menos un margen para que
        // no vuelva a rebotar si el cobro cambia entre una llamada y otra.
        //
        // El piso existe porque por debajo de ~256 el modelo se corta a media
        // herramienta y devuelve un JSON truncado, que es peor que fallar
        // claro: parece un bug del agente cuando en realidad es falta de saldo.
        if (e.kind === "presupuesto" && attempt < RETRY.maxRetries) {
          const sugerido = e.opts.maxTokensSugerido ?? 0;
          const techo = Math.floor(sugerido * 0.9);
          const actual = enCurso.maxTokens ?? DEFAULT_MAX_TOKENS;

          if (techo >= MIN_MAX_TOKENS && techo < actual) {
            callbacks.onRetry?.({ attempt: attempt + 1, waitMs: 0, reason: e.kind });
            enCurso = { ...enCurso, maxTokens: techo };
            attempt++;
            continue;
          }
          // Ni recortando cabe: es falta de saldo de verdad, no un techo alto.
          throw e;
        }

        if (!e.retryable || attempt >= RETRY.maxRetries) throw err;

        // Backoff exponencial con tope; el servidor puede pedir una espera mayor.
        const waitMs = Math.min(RETRY.baseMs * 2 ** attempt, RETRY.capMs);
        const wait = e.opts.retryAfterMs ?? waitMs;
        callbacks.onRetry?.({ attempt: attempt + 1, waitMs: wait, reason: e.kind });
        await sleep(wait);
        attempt++;
      }
    }
  }

  private async once(
    params: StreamParams,
    callbacks: StreamCallbacks,
  ): Promise<Extract<StreamEvent, { type: "end" }>> {
    const body = {
      model: params.model ?? this.defaultModel,
      messages: toOpenAIMessages(params.system, params.messages),
      ...(params.tools?.length ? { tools: params.tools.map(toOpenAITool) } : {}),
      max_tokens: params.maxTokens ?? DEFAULT_MAX_TOKENS,
      stream: true,
      // Sin esto, el último chunk no trae el conteo de tokens.
      stream_options: { include_usage: true },
    };

    let res: Response;
    try {
      res = await fetch(`${this.opts.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.opts.apiKey}`,
          ...this.opts.extraHeaders,
        },
        body: JSON.stringify(body),
        signal: params.signal,
      });
    } catch (err) {
      if (params.signal?.aborted) throw err; // interrupción: no es fallo de red
      throw new ProviderError(`no se pudo conectar con ${this.name}: ${String(err)}`, "network");
    }

    if (!res.ok) throw await errorFromResponse(res, this.name);
    if (!res.body) throw new ProviderError("respuesta sin cuerpo", "network");

    return this.readStream(res.body, callbacks, params.signal);
  }

  /** Lee el SSE y reensambla el mensaje completo del assistant. */
  private async readStream(
    body: ReadableStream<Uint8Array>,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<Extract<StreamEvent, { type: "end" }>> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    let text = "";
    // Los tool_calls llegan partidos: se acumulan por índice hasta el final.
    const toolCalls = new Map<number, { id: string; name: string; args: string }>();
    let finishReason: string | null = null;
    let usage: { inputTokens: number; outputTokens: number } | undefined;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (signal?.aborted) break;

        buffer += decoder.decode(value, { stream: true });

        // Los eventos SSE se separan por línea en blanco.
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);

          for (const line of raw.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") continue;
            if (!data) continue;

            let chunk: any;
            try {
              chunk = JSON.parse(data);
            } catch {
              continue; // chunk partido o comentario del proveedor: se ignora
            }

            // Algunos proveedores mandan el error dentro del stream, ya con 200.
            if (chunk.error) {
              throw new ProviderError(
                `${this.name}: ${chunk.error.message ?? JSON.stringify(chunk.error)}`,
                kindFromMessage(chunk.error.message),
              );
            }

            if (chunk.usage) {
              usage = {
                inputTokens: chunk.usage.prompt_tokens ?? 0,
                outputTokens: chunk.usage.completion_tokens ?? 0,
              };
            }

            const choice = chunk.choices?.[0];
            if (!choice) continue;
            if (choice.finish_reason) finishReason = choice.finish_reason;

            const delta = choice.delta;
            if (!delta) continue;

            if (typeof delta.content === "string" && delta.content.length > 0) {
              text += delta.content;
              callbacks.onText?.(delta.content);
            }

            // Algunos modelos con razonamiento mandan esto aparte del contenido.
            const razonamiento = delta.reasoning ?? delta.reasoning_content;
            if (typeof razonamiento === "string" && razonamiento.length > 0) {
              callbacks.onThinking?.(razonamiento);
            }

            for (const tc of delta.tool_calls ?? []) {
              const i = tc.index ?? 0;
              const acc = toolCalls.get(i) ?? { id: "", name: "", args: "" };
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.name += tc.function.name;
              if (tc.function?.arguments) acc.args += tc.function.arguments;
              toolCalls.set(i, acc);
            }
          }
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }

    // Armar el mensaje del assistant en nuestro formato.
    const content: ContentBlock[] = [];
    if (text) content.push({ type: "text", text });

    for (const [i, tc] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
      content.push({
        type: "tool_use",
        // Sin id (algunos proveedores no lo mandan) se inventa uno estable:
        // el tool_result tiene que poder referirse a esta llamada.
        id: tc.id || `call_${i}`,
        name: tc.name,
        input: parseArgs(tc.args, tc.name),
      });
    }

    // Si hay tool_calls, el turno pide ejecutarlas — aunque el proveedor haya
    // dicho "stop" (los hay que no marcan finish_reason correctamente).
    const stopReason: StopReason = toolCalls.size > 0 ? "tool_use" : mapFinish(finishReason);

    return {
      type: "end",
      stopReason,
      message: { role: "assistant", content },
      usage,
    };
  }
}

// ── Traducción de formatos ──────────────────────────────────────────────────

/**
 * Nuestro formato → el de OpenAI.
 *
 * La diferencia estructural: nosotros (como Anthropic) metemos los resultados de
 * tools como bloques dentro de un mensaje `user`; OpenAI quiere un mensaje
 * aparte con `role: "tool"` por cada resultado. Un mensaje nuestro puede
 * convertirse en varios suyos.
 */
function toOpenAIMessages(system: string | undefined, messages: Message[]): unknown[] {
  const out: unknown[] = [];
  if (system) out.push({ role: "system", content: system });

  for (const m of messages) {
    const textos = m.content.filter((c) => c.type === "text") as Extract<ContentBlock, { type: "text" }>[];
    const usos = m.content.filter((c) => c.type === "tool_use") as Extract<ContentBlock, { type: "tool_use" }>[];
    const resultados = m.content.filter((c) => c.type === "tool_result") as Extract<
      ContentBlock,
      { type: "tool_result" }
    >[];
    const imagenes = m.content.filter((c) => c.type === "image") as Extract<
      ContentBlock,
      { type: "image" }
    >[];

    // Los resultados van primero: responden a la llamada del mensaje anterior.
    for (const r of resultados) {
      out.push({
        role: "tool",
        tool_call_id: r.tool_use_id,
        content: r.content,
      });
    }

    if (m.role === "assistant") {
      if (textos.length === 0 && usos.length === 0) continue;
      out.push({
        role: "assistant",
        content: textos.map((t) => t.text).join("") || null,
        ...(usos.length
          ? {
              tool_calls: usos.map((u) => ({
                id: u.id,
                type: "function",
                function: { name: u.name, arguments: JSON.stringify(u.input) },
              })),
            }
          : {}),
      });
    } else if (imagenes.length > 0) {
      // Con imágenes el contenido deja de ser un string y pasa a ser una lista
      // de partes. Las imágenes van ANTES del texto: los modelos responden mejor
      // así, y lo dicen las dos documentaciones oficiales.
      out.push({
        role: "user",
        content: [
          ...imagenes.map((img) => ({
            type: "image_url",
            image_url: { url: `data:${img.mediaType};base64,${img.data}` },
          })),
          ...textos.map((t) => ({ type: "text", text: t.text })),
        ],
      });
    } else if (textos.length > 0) {
      out.push({ role: "user", content: textos.map((t) => t.text).join("") });
    }
  }

  return out;
}

function toOpenAITool(t: { name: string; description: string; input_schema: unknown }): unknown {
  return {
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  };
}

/**
 * Los argumentos llegan como string de JSON armado token por token. La doc de
 * OpenAI avisa que el modelo no siempre genera JSON válido, así que un fallo
 * aquí NO debe tirar el turno: se manda un objeto vacío y la tool se queja con
 * un mensaje que el modelo puede entender y corregir.
 */
function parseArgs(raw: string, toolName: string): Record<string, unknown> {
  const s = raw.trim();
  if (!s) return {};
  try {
    const parsed = JSON.parse(s);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    console.warn(`[provider] argumentos inválidos para ${toolName}: ${s.slice(0, 120)}`);
    return {};
  }
}

function mapFinish(reason: string | null): StopReason {
  switch (reason) {
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return "end_turn";
  }
}

function kindFromMessage(msg: unknown): ProviderError["kind"] {
  const t = String(msg ?? "").toLowerCase();
  if (t.includes("rate") || t.includes("quota")) return "rate_limit";
  if (t.includes("overload") || t.includes("capacity")) return "overloaded";
  return "api";
}

async function errorFromResponse(res: Response, name: string): Promise<ProviderError> {
  let detalle = "";
  try {
    const body = await res.text();
    const json = JSON.parse(body);
    detalle = json?.error?.message ?? body.slice(0, 200);
  } catch {
    detalle = res.statusText;
  }

  const retryAfter = res.headers.get("retry-after");
  const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : undefined;

  if (res.status === 401 || res.status === 403) {
    return new ProviderError(`${name}: key inválida o sin permisos`, "auth");
  }
  if (res.status === 429) {
    return new ProviderError(`${name}: límite de uso alcanzado. ${detalle}`, "rate_limit", { status: res.status, retryAfterMs });
  }
  if (res.status === 402) {
    // Un 402 son DOS cosas distintas y hay que separarlas.
    //
    // OpenRouter valida el saldo contra el MÁXIMO POSIBLE de salida, no contra
    // lo que la respuesta va a costar de verdad: pedir max_tokens 8192 tumba
    // una petición que habría gastado 200. El mensaje viene con la forma "can
    // only afford N", así que el proveedor está diciendo con qué techo sí pasa.
    //
    // Con saldo real de cero no hay número que sirva y sigue siendo "auth".
    const cabe = /can only afford (\d+)/i.exec(detalle);
    if (cabe) {
      return new ProviderError(
        `${name}: el techo de salida no cabe en el saldo de la key. ${detalle}`,
        "presupuesto",
        { status: res.status, maxTokensSugerido: Number(cabe[1]) },
      );
    }
    return new ProviderError(`${name}: sin créditos. ${detalle}`, "auth");
  }
  if (res.status >= 500) {
    return new ProviderError(`${name}: el servicio no responde. ${detalle}`, "overloaded", { status: res.status, retryAfterMs });
  }
  return new ProviderError(`${name}: ${detalle}`, "api");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
