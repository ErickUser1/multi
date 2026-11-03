import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { OpenAICompatProvider } from "./openai-compat.js";
import { ProviderError } from "./types.js";

/**
 * Gemini en Vertex AI (Google Cloud), para usar los créditos de Google.
 *
 * Va por la API de Vertex compatible con OpenAI, así que el cliente es el mismo
 * de OpenRouter y compañía. Lo distinto es el permiso: la organización de Google
 * de Multti no deja crear API keys ni claves JSON de cuenta de servicio (es la
 * política "segura por defecto" de las cuentas nuevas), así que se entra con las
 * credenciales predeterminadas (ADC) que deja `gcloud auth application-default
 * login` en el server. Ese archivo trae un refresh token; con él se pide un token
 * de acceso que dura una hora, y se renueva solo antes de que caduque.
 *
 * Por qué Vertex y no la API de Gemini de AI Studio: los créditos del programa de
 * startups se cargan al proyecto de Google Cloud, y hay varios reportes de keys de
 * AI Studio que cobraron a la tarjeta en vez de usarlos.
 */

/** El modelo de entrada. Probado en el proyecto de Multti el 3 de nov de 2026. */
const MODELO_POR_DEFECTO = "gemini-4-argon";

/**
 * Para las llamadas a herramientas que no hizo Gemini (las de Claude, antes de
 * pasarse al respaldo a media conversación): Gemini exige una firma en cada
 * llamada del historial, y la doc de Google da este valor para las que vienen de
 * otro lado.
 */
const FIRMA_AJENA = { google: { thought_signature: "skip_thought_signature_validator" } };

export interface ConfigVertex {
  proyecto: string;
  modelo: string;
  region: string;
  /** El archivo de ADC. */
  credenciales: string;
}

/** La configuración del `.env`, o null si quien corre Multti no puso Vertex. */
export function configVertex(env: NodeJS.ProcessEnv = process.env): ConfigVertex | null {
  const proyecto = env.VERTEX_PROJECT?.trim();
  if (!proyecto) return null;
  return {
    proyecto,
    modelo: env.VERTEX_MODEL?.trim() || MODELO_POR_DEFECTO,
    region: env.VERTEX_LOCATION?.trim() || "global",
    credenciales:
      env.GOOGLE_APPLICATION_CREDENTIALS?.trim() ||
      join(homedir(), ".config", "gcloud", "application_default_credentials.json"),
  };
}

export function urlDeVertex(c: Pick<ConfigVertex, "proyecto" | "region">): string {
  const host = c.region === "global" ? "aiplatform.googleapis.com" : `${c.region}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${c.proyecto}/locations/${c.region}/endpoints/openapi`;
}

/**
 * El token de acceso, cacheado hasta un minuto antes de que caduque.
 *
 * Uno por archivo de credenciales: todas las salas comparten el mismo, y pedir
 * uno nuevo en cada vuelta del agente serían cientos de llamadas a Google por
 * hora para nada.
 */
const tokens = new Map<string, { token: string; vence: number; pidiendo?: Promise<string> }>();

export function obtenerTokenDe(archivo: string, ahora: () => number = Date.now): () => Promise<string> {
  return async () => {
    const enCache = tokens.get(archivo);
    if (enCache && enCache.vence > ahora()) return enCache.token;
    // Si ya hay una renovación en curso (varias salas a la vez), se espera esa.
    if (enCache?.pidiendo) return enCache.pidiendo;

    const pidiendo = renovar(archivo, ahora);
    tokens.set(archivo, { token: enCache?.token ?? "", vence: 0, pidiendo });
    try {
      return await pidiendo;
    } finally {
      const actual = tokens.get(archivo);
      if (actual?.pidiendo === pidiendo) delete actual.pidiendo;
    }
  };
}

async function renovar(archivo: string, ahora: () => number): Promise<string> {
  let cred: Record<string, unknown>;
  try {
    cred = JSON.parse(await readFile(archivo, "utf8"));
  } catch {
    throw new ProviderError(
      `no se encontró el archivo de credenciales de Google (${archivo}). Corre "gcloud auth application-default login" en el server`,
      "auth",
    );
  }
  if (cred.type !== "authorized_user" || !cred.refresh_token || !cred.client_id || !cred.client_secret) {
    throw new ProviderError(
      `las credenciales de Google (${archivo}) no son de usuario (type: ${String(cred.type)}). Corre "gcloud auth application-default login" en el server`,
      "auth",
    );
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: String(cred.refresh_token),
      client_id: String(cred.client_id),
      client_secret: String(cred.client_secret),
    }),
  });
  const d = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !d.access_token) {
    // invalid_grant: el permiso se revocó o caducó. Hay que volver a hacer login.
    throw new ProviderError(
      `Google no renovó el permiso (${d.error ?? res.status}). Corre "gcloud auth application-default login" en el server`,
      "auth",
    );
  }
  const vence = ahora() + ((d.expires_in ?? 3600) - 60) * 1000;
  tokens.set(archivo, { token: d.access_token, vence });
  return d.access_token;
}

/** El proveedor de Gemini en Vertex, o null si no está configurado. */
export function crearProveedorVertex(env: NodeJS.ProcessEnv = process.env): OpenAICompatProvider | null {
  const c = configVertex(env);
  if (!c) return null;
  return new OpenAICompatProvider({
    obtenerToken: obtenerTokenDe(c.credenciales),
    baseUrl: urlDeVertex(c),
    // La API compatible pide el modelo con su editor delante.
    defaultModel: c.modelo.startsWith("google/") ? c.modelo : `google/${c.modelo}`,
    name: "Gemini (Vertex)",
    // Igual que con Claude: con 8k un archivo grande no cabe y el agente gira en falso.
    maxTokens: 32_000,
    extraPorDefecto: FIRMA_AJENA,
  });
}

/** Para las pruebas: olvidar los tokens cacheados. */
export function olvidarTokensDeVertex(): void {
  tokens.clear();
}
