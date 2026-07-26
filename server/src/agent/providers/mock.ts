import {
  type ModelProvider,
  type StreamParams,
  type StreamCallbacks,
  type StreamEvent,
  type Message,
  type ContentBlock,
} from "./types.js";

/**
 * Proveedor MOCK — simula al modelo sin llamar a ninguna API.
 * Permite construir y probar el loop, las tools y la sala sin API key.
 *
 * Comportamiento: mira el último mensaje del usuario y, si contiene ciertas
 * palabras, responde con un tool_use predefinido (ej. editar App.jsx). Así
 * podemos ejercitar el round-trip completo (tool_use → ejecución → resultado).
 *
 * Los guiones se registran con `scenario()`. Si ninguno matchea, responde texto.
 */

type Scenario = {
  /** Se activa si el texto del último mensaje user matchea. */
  match: (userText: string) => boolean;
  /** Bloques que "genera" el assistant (texto y/o tool_use). */
  reply: (userText: string) => ContentBlock[];
};

export class MockProvider implements ModelProvider {
  readonly name = "mock";
  readonly defaultModel = "mock-1";

  private scenarios: Scenario[] = [];
  /** Recuerda qué tool_use ya ejecutó para no repetirlo en el siguiente turno. */
  private served = new Set<string>();

  scenario(s: Scenario): this {
    this.scenarios.push(s);
    return this;
  }

  async stream(
    params: StreamParams,
    callbacks: StreamCallbacks = {},
  ): Promise<Extract<StreamEvent, { type: "end" }>> {
    const userText = lastUserText(params.messages);

    // ¿El último mensaje trae resultados de tool? Entonces es el 2º turno:
    // el modelo ya "vio" el resultado y ahora cierra con texto (end_turn).
    const lastMsg = params.messages[params.messages.length - 1];
    const hasToolResults =
      lastMsg?.role === "user" && lastMsg.content.some((c) => c.type === "tool_result");

    let content: ContentBlock[];
    let stopReason: "tool_use" | "end_turn";

    if (hasToolResults) {
      content = [{ type: "text", text: "Listo, ya quedó." }];
      stopReason = "end_turn";
    } else {
      const scenario = this.scenarios.find((s) => s.match(userText));
      if (scenario) {
        content = scenario.reply(userText);
        // Si el guion incluye tool_use, el turno para en tool_use.
        stopReason = content.some((c) => c.type === "tool_use") ? "tool_use" : "end_turn";
      } else {
        content = [{ type: "text", text: `(mock) No tengo un guion para: "${userText}"` }];
        stopReason = "end_turn";
      }
    }

    // Simular streaming: emitir el texto por pedazos.
    for (const block of content) {
      if (block.type === "text") {
        for (const chunk of chunkText(block.text)) {
          callbacks.onText?.(chunk);
          await sleep(15);
        }
      }
    }

    // Dar ids únicos a los tool_use.
    const message: Message = {
      role: "assistant",
      content: content.map((c) =>
        c.type === "tool_use" && !c.id ? { ...c, id: `mock_${Math.random().toString(36).slice(2, 10)}` } : c,
      ),
    };

    return {
      type: "end",
      stopReason,
      message,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}

function lastUserText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user") {
      const txt = m.content.find((c) => c.type === "text");
      if (txt && txt.type === "text") return txt.text;
    }
  }
  return "";
}

function chunkText(text: string): string[] {
  // Partir en "palabras" para simular tokens.
  return text.match(/\S+\s*/g) ?? [text];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
