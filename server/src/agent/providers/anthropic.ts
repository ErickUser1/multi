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
import { rutaEnJsonParcial } from "./json-parcial.js";

const API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
// Sonnet en vez de Opus a propósito. Una sala de Multi es un loop agéntico: cada
// turno reenvía el historial completo, y con Opus una sesión de dos horas se come
// el saldo de una semana (pasó, 17 dólares en una tarde). Sonnet hace igual de
// bien lo que se pide aquí (scaffoldear, editar, rediseñar) por menos de la mitad.
// Quien quiera Opus lo pone en MULTI_MODEL o desde la Sala.
//
// Sonnet 5.5 cuesta lo mismo que Sonnet 5 y rompe cosas que aquí no se usan:
// no se manda `thinking` (corre adaptivo, igual que antes), ni `tool_choice`
// forzado, ni temperatura. Los bloques de thinking no se reenvían al historial
// (ver `buildMessage()`), así que su chequeo de historial editado no tiene nada que
// revisar: lo que se recorta del historial entre turnos no puede dar un 400.
const DEFAULT_MODEL = "claude-sonnet-5-5";
/**
 * Tope de tokens que el modelo puede DEVOLVER en una respuesta.
 *
 * Estaba en 8192, que con Sonnet (128k de salida) es un dieciseisavo de lo que
 * el modelo puede dar. Con ese tope un archivo grande no cabe: el agente empieza
 * a escribirlo, se queda sin espacio a media escritura, la tool queda trunca y
 * REINTENTA IGUAL. Se vio en vivo, cinco vueltas seguidas con `salida 8192` y el
 * contexto congelado en el mismo numero: el turno gira en falso hasta el tope de
 * vueltas, quemando saldo en cada una, y la sala se queda con el andamiaje del
 * proyecto y nada mas.
 *
 * Pasaba con juegos y no con paginas simples porque lo que no cabia era el
 * ARCHIVO, no la tarea.
 *
 * 32k y no los 128k que soporta el modelo: con esto un archivo grande entra de
 * sobra, y un tope sigue siendo util para que una respuesta desbocada no se lleve
 * el saldo de una sala entera.
 */
const DEFAULT_MAX_TOKENS = 32_000;

// Retry: 429 (rate limit) y 529 (overloaded). Config estilo CCX.
const RETRY = { maxRetries: 5, baseMs: 1000, capMs: 60_000 };

/**
 * Cuánto puede pasar sin que llegue NADA por el stream antes de darlo por muerto.
 *
 * `fetch` no tiene límite entre pedazo y pedazo: si la conexión se queda abierta
 * pero ya no llega nada, `reader.read()` espera para siempre, y la sala se queda
 * en "trabajando" hasta que alguien reinicia el server (pasó). Anthropic manda
 * pings mientras el modelo piensa o escribe, así que un silencio de minuto y
 * medio no es un modelo lento: es una conexión muerta. Se corta y se reintenta.
 *
 * Se lee en cada request para que la demo lo pueda bajar a un segundo.
 */
const silencioMaximoMs = () => Number(process.env.MULTI_STREAM_SILENCIO_MS) || 90_000;

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
        // Alguien de la sala interrumpió: cortar la conexión no es una falla de
        // red y no se reintenta. Antes se reintentaba cinco veces, y el "@agente"
        // tardaba medio minuto en soltar al agente.
        if (params.signal?.aborted) throw err;
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

    // Un corte propio, para poder soltar una conexión muda sin tocar la señal de
    // la sala. Si la sala interrumpe, también corta este.
    const corte = new AbortController();
    const interrumpir = () => corte.abort();
    if (params.signal?.aborted) corte.abort();
    params.signal?.addEventListener("abort", interrumpir, { once: true });
    const vigilante = vigilarSilencio(corte);

    try {
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
          signal: corte.signal,
        });
      } catch (err) {
        if (vigilante.mudo()) throw vigilante.error();
        throw new ProviderError("fallo de red al llamar la API", "network", { cause: err });
      }

      if (!res.ok) throw await httpError(res);
      if (!res.body) throw new ProviderError("respuesta sin body", "api", { status: res.status });

      return await this.consumeStream(res.body, callbacks, vigilante);
    } finally {
      vigilante.parar();
      params.signal?.removeEventListener("abort", interrumpir);
    }
  }

  /** Lee el stream SSE byte a byte, reensambla bloques, emite el evento `end`. */
  private async consumeStream(
    body: ReadableStream<Uint8Array>,
    callbacks: StreamCallbacks,
    vigilante: ReturnType<typeof vigilarSilencio>,
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
        vigilante.latido();
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
      if (vigilante.mudo()) throw vigilante.error();
      throw new ProviderError("error leyendo el stream", "network", { cause: err });
    } finally {
      reader.releaseLock();
    }

    // El stream terminó. acc ya vio message_delta (stop_reason) y message_stop.
    if (!acc.stopReason) {
      throw new ProviderError("el stream terminó sin stop_reason", "parse");
    }

    const message = acc.buildMessage();
    return {
      type: "end",
      stopReason: acc.stopReason,
      message,
      usage: acc.usage,
      herramientaCortada: acc.herramientaCortada,
      archivoCortado: acc.archivoCortado,
      inputsInvalidos: acc.inputsInvalidos.length ? acc.inputsInvalidos : undefined,
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
        acc.onBlockStop(data.index, callbacks);
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
  /** Si `buildMessage` descartó un tool_use que el tope dejó a medias. */
  herramientaCortada = false;
  /** La ruta del archivo que el tope dejó a medias, si se alcanzó a leer. */
  archivoCortado: string | undefined;
  /**
   * Los tool_use cuyo input llegó completo pero no es JSON válido. Con
   * `eager_input_streaming` la API ya no valida el JSON antes de mandarlo, y la
   * doc avisa que puede pasar: se le contesta a esa tool con un error en vez de
   * tumbar el turno entero.
   */
  inputsInvalidos: string[] = [];
  usage: Extract<StreamEvent, { type: "end" }>["usage"];

  // Bloques por índice, en construcción.
  private blocks = new Map<
    number,
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; jsonBuf: string; anunciada?: boolean }
    | { type: "thinking"; text: string }
    /**
     * Lo que corre del lado de Anthropic (ver `crudo` en types.ts). Los
     * resultados llegan completos en `content_block_start`; un
     * `server_tool_use` trae su input en deltas, igual que un `tool_use`.
     */
    | { type: "crudo"; bloque: Record<string, unknown>; jsonBuf: string }
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
    } else if (cb && typeof cb.type === "string" && cb.type !== "redacted_thinking") {
      // Todo lo demás es de las herramientas de Anthropic y se regresa tal cual.
      // `redacted_thinking` no: el thinking no se reenvía (ver buildMessage).
      this.blocks.set(index, { type: "crudo", bloque: { ...cb }, jsonBuf: "" });
    }
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
        if (block.type === "tool_use" || block.type === "crudo") {
          block.jsonBuf += delta.partial_json ?? "";
        }
        // En cuanto se sabe a qué archivo va, se anuncia: escribir uno grande
        // tarda minutos. La ruta va al principio, así que solo se busca en los
        // primeros caracteres (y no se reescanea un archivo entero en cada delta).
        if (block.type === "tool_use" && !block.anunciada && block.jsonBuf.length < 2_000) {
          const path = rutaEnJsonParcial(block.jsonBuf);
          if (path) {
            block.anunciada = true;
            callbacks.onToolPreparing?.({ id: block.id, name: block.name, input: { path } });
          }
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

  onBlockStop(index: number, callbacks: StreamCallbacks): void {
    // El input del tool_use ya está completo en jsonBuf; se parsea en buildMessage.
    // El de una herramienta de Anthropic se arma aquí: ya corrió (o corre en la
    // siguiente llamada) y solo hay que enseñarlo y guardarlo.
    const block = this.blocks.get(index);
    if (block?.type !== "crudo" || block.bloque.type !== "server_tool_use") return;
    const raw = block.jsonBuf.trim();
    if (raw.length) {
      try {
        block.bloque.input = JSON.parse(raw);
      } catch {
        // Cortado a media escritura: se queda con lo que traía el start.
      }
    }
    block.bloque.input ??= {};
    callbacks.onServerTool?.({
      id: String(block.bloque.id ?? ""),
      name: String(block.bloque.name ?? ""),
      input: block.bloque.input as Record<string, unknown>,
    });
  }

  onMessageDelta(delta: any, usage: any): void {
    if (delta?.stop_reason) this.stopReason = delta.stop_reason as StopReason;
    // usage en message_delta es acumulativo (output_tokens final).
    if (usage && this.usage) {
      this.usage.outputTokens = usage.output_tokens ?? this.usage.outputTokens;
      const servidor = usage.server_tool_use;
      if (servidor?.web_search_requests) this.usage.busquedas = servidor.web_search_requests;
      if (servidor?.web_fetch_requests) this.usage.lecturas = servidor.web_fetch_requests;
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
            // Cortado por el tope de salida y no por la red: el modelo estaba
            // escribiendo los argumentos (casi siempre un archivo grande) y se
            // le acabó el espacio. No es un error del turno: este bloque se
            // descarta y el loop le pide que lo haga en partes (ver
            // AVISO_SIN_ESPACIO en loop.ts). Antes esto culpaba a los créditos.
            if (this.stopReason === "max_tokens") {
              this.herramientaCortada = true;
              this.archivoCortado ??= rutaEnJsonParcial(raw);
              continue;
            }
            // El modelo terminó de escribirlo y pidió correrlo, pero no parsea.
            // Va con input vacío (el historial necesita uno) y el loop le
            // contesta con un error para que lo repita.
            if (this.stopReason === "tool_use") {
              this.inputsInvalidos.push(b.id);
              content.push({ type: "tool_use", id: b.id, name: b.name, input: {} });
              continue;
            }
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
      } else if (b.type === "crudo") {
        content.push({ type: "crudo", bloque: b.bloque });
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
    body.tools = [
      ...params.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
        // Los argumentos llegan mientras el modelo los escribe, no hasta que
        // termina. Sin esto Anthropic junta el input completo antes de mandarlo:
        // un archivo grande eran minutos sin un solo byte, la sala sin enseñar
        // nada y la conexión callada justo donde se puede quedar muda. El costo
        // es que el JSON ya no viene validado (ver `inputsInvalidos`).
        eager_input_streaming: true,
      })),
      // Al final y siempre iguales: las tools son el principio del prefijo del
      // caché, y cualquier cambio aquí lo tira completo.
      ...herramientasWeb(String(body.model)),
    ];
  }

  return body;
}

/**
 * Buscar en internet y leer páginas, las dos corren del lado de Anthropic.
 *
 * Buscar cuesta un centavo de dólar por búsqueda y leer no se cobra aparte,
 * pero en los dos lo caro son los tokens de lo que regresan. Por eso los topes:
 * `max_uses` es por llamada a la API, y `max_content_tokens` evita que un PDF
 * de cien páginas se coma el saldo de la sala.
 *
 * Las versiones `_20260318` traen el filtrado: Claude escribe código del lado
 * de Anthropic para quedarse solo con lo que sirve antes de que entre al
 * contexto, y `response_inclusion: "excluded"` deja fuera de la respuesta lo que
 * ese código ya leyó. Solo los modelos 4.6 y posteriores lo tienen; los demás
 * (Haiku 4.5) usan las básicas, que meten los resultados completos.
 */
export function herramientasWeb(modelo: string): Record<string, unknown>[] {
  const ubicacion = { type: "approximate", country: "MX", timezone: "America/Mexico_City" };
  if (!conFiltrado(modelo)) {
    return [
      { type: "web_search_20250305", name: "web_search", max_uses: 5, user_location: ubicacion },
      { type: "web_fetch_20250910", name: "web_fetch", max_uses: 5, max_content_tokens: 20_000 },
    ];
  }
  return [
    {
      type: "web_search_20260318",
      name: "web_search",
      max_uses: 5,
      user_location: ubicacion,
      response_inclusion: "excluded",
    },
    {
      type: "web_fetch_20260318",
      name: "web_fetch",
      max_uses: 5,
      max_content_tokens: 20_000,
      response_inclusion: "excluded",
    },
  ];
}

/**
 * Lo que una herramienta de Anthropic buscó o leyó, para enseñarlo y para
 * acordarse después.
 *
 * Con el filtrado, el modelo casi nunca llama `web_search` directo: escribe
 * código que lo llama (`code_execution`), y la llamada de adentro ni siquiera
 * llega en la respuesta (`response_inclusion: "excluded"`). Lo único que queda
 * es el código, así que de ahí se sacan la búsqueda y la URL.
 */
export function busquedasEn(
  name: string,
  input: Record<string, unknown>,
): { name: "web_search" | "web_fetch"; input: Record<string, unknown> }[] {
  if (name === "web_search" || name === "web_fetch") return [{ name, input }];
  if (typeof input.code !== "string") return [];
  const encontradas: { name: "web_search" | "web_fetch"; input: Record<string, unknown> }[] = [];
  const patron = /(web_search|web_fetch)\(\s*\{\s*["'](query|url)["']\s*:\s*(["'])((?:\\.|(?!\3).)*)\3/g;
  for (const m of input.code.matchAll(patron)) {
    // Es para leerlo, no para usarlo: basta con quitar los escapes.
    const valor = m[4]!.replace(/\\(.)/g, "$1");
    encontradas.push({ name: m[1] as "web_search" | "web_fetch", input: { [m[2]!]: valor } });
  }
  return encontradas;
}

/** Si el modelo tiene el filtrado de resultados: Claude 4.6 en adelante. */
function conFiltrado(modelo: string): boolean {
  const m = /claude-(?:opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/.exec(modelo);
  if (!m) return false;
  const mayor = Number(m[1]);
  // "claude-opus-5" no trae menor; "claude-haiku-4-5-20251001" sí. Un menor de
  // ocho cifras es la fecha, no la versión.
  const menor = m[2] && m[2].length < 8 ? Number(m[2]) : 0;
  if (modelo.includes("haiku")) return false;
  return mayor > 4 || (mayor === 4 && menor >= 6);
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
        case "documento":
          // La API lee el PDF entero: no hay que extraerle el texto aquí.
          return {
            type: "document",
            source: { type: "base64", media_type: block.mediaType, data: block.data },
          };
        case "crudo":
          // Tal cual llegó: la API valida el `encrypted_content` byte por byte.
          return block.bloque;
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

/**
 * El timer de `silencioMaximoMs`: se rearma con cada pedazo que llega (pings
 * incluidos) y, si vence, corta la conexión.
 */
function vigilarSilencio(corte: AbortController) {
  const limite = silencioMaximoMs();
  const inicio = Date.now();
  let vencio = false;
  let timer: ReturnType<typeof setTimeout>;
  const armar = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      vencio = true;
      console.warn(
        `[agente] el stream lleva ${Math.round(limite / 1000)}s sin datos (a los ${Math.round((Date.now() - inicio) / 1000)}s del request) — se corta y se reintenta`,
      );
      corte.abort();
    }, limite);
  };
  armar();
  return {
    latido: armar,
    parar: () => clearTimeout(timer),
    mudo: () => vencio,
    error: () => new ProviderError(`el stream se quedó ${Math.round(limite / 1000)}s sin datos`, "network"),
  };
}

function backoff(attempt: number): number {
  // Exponencial con tope y jitter.
  const exp = Math.min(RETRY.baseMs * 2 ** (attempt - 1), RETRY.capMs);
  return exp + Math.random() * 250;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
