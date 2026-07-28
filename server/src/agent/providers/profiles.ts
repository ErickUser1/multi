import { AnthropicProvider } from "./anthropic.js";
import { OpenAICompatProvider } from "./openai-compat.js";
import type { ModelProvider } from "./types.js";

/**
 * Los proveedores que Multi conoce.
 *
 * Casi todos hablan el formato de OpenAI, así que un solo cliente los cubre y
 * lo único que cambia es la URL base y el modelo por defecto. El patrón y las
 * URLs salen de OpenCode (`packages/llm/src/providers/openai-compatible-profile.ts`),
 * que resuelve esto igual: un protocolo, muchos perfiles.
 *
 * Importa para un proyecto open source: quien lo corra trae el modelo que puede
 * pagar — o el que tiene corriendo en su máquina.
 */

export interface Perfil {
  /** Cómo se llama para el usuario. */
  label: string;
  /** Cómo se ve una key suya, para atajar el típico "pegué la que no era". */
  keyHint: string;
  /** Enlace a donde se saca. */
  keyUrl?: string;
  modelosSugeridos: string[];
}

export const PERFILES = {
  anthropic: {
    label: "Anthropic",
    keyHint: "sk-ant-…",
    keyUrl: "https://console.anthropic.com/settings/keys",
    modelosSugeridos: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"],
  },
  openrouter: {
    label: "OpenRouter",
    keyHint: "sk-or-v1-…",
    keyUrl: "https://openrouter.ai/keys",
    // Un modelo gratis primero: es la puerta de entrada para quien no quiere pagar.
    modelosSugeridos: [
      "google/gemma-4-26b-a4b-it:free",
      "anthropic/claude-opus-5",
      "openai/gpt-5",
      "deepseek/deepseek-chat",
    ],
  },
  openai: {
    label: "OpenAI",
    keyHint: "sk-…",
    keyUrl: "https://platform.openai.com/api-keys",
    modelosSugeridos: ["gpt-5", "gpt-5-mini"],
  },
  groq: {
    label: "Groq",
    keyHint: "gsk_…",
    keyUrl: "https://console.groq.com/keys",
    modelosSugeridos: ["llama-3.3-70b-versatile"],
  },
  deepseek: {
    label: "DeepSeek",
    keyHint: "sk-…",
    keyUrl: "https://platform.deepseek.com/api_keys",
    modelosSugeridos: ["deepseek-chat", "deepseek-reasoner"],
  },
  ollama: {
    label: "Ollama (local)",
    // Ollama no pide key, pero el resto del flujo espera una: cualquier texto sirve.
    keyHint: "cualquier cosa (Ollama no pide key)",
    modelosSugeridos: ["gemma3", "qwen2.5-coder"],
  },
} as const satisfies Record<string, Perfil>;

export type ProviderId = keyof typeof PERFILES;

/** URLs base, tomadas del catálogo de OpenCode. */
const BASE_URLS: Record<Exclude<ProviderId, "anthropic">, string> = {
  openrouter: "https://openrouter.ai/api/v1",
  openai: "https://api.openai.com/v1",
  groq: "https://api.groq.com/openai/v1",
  deepseek: "https://api.deepseek.com/v1",
  ollama: "http://localhost:11434/v1",
};

export function esProviderId(v: unknown): v is ProviderId {
  return typeof v === "string" && v in PERFILES;
}

/**
 * Construye el proveedor. Anthropic tiene su propio cliente (su API no es
 * compatible con la de OpenAI); todos los demás comparten uno.
 */
export function makeProvider(id: ProviderId, apiKey: string, modelo?: string): ModelProvider {
  if (id === "anthropic") return new AnthropicProvider(apiKey);

  const perfil = PERFILES[id];
  return new OpenAICompatProvider({
    apiKey,
    baseUrl: BASE_URLS[id],
    defaultModel: modelo ?? perfil.modelosSugeridos[0],
    name: perfil.label,
    // OpenRouter pide identificar la app que llama (aparece en su ranking).
    extraHeaders:
      id === "openrouter"
        ? { "HTTP-Referer": "https://github.com/multi", "X-Title": "Multi" }
        : undefined,
  });
}
