import { useEffect, useState } from "react";
import { SERVER_URL } from "./socket.js";

/**
 * Tu proveedor de modelo y tu API key.
 *
 * Es TUYO, no de la sala: se configura una vez y sirve en todas. Vive en este
 * navegador (localStorage), así que sigue ahí mañana y en la sala que crees
 * después. Sin cuentas todavía, el navegador es el único lugar donde puede
 * vivir algo "del usuario".
 *
 * Cada quien puede traer un proveedor distinto — uno con Claude, otro con un
 * modelo gratis, otro con Ollama en su máquina. En un proyecto que cualquiera
 * puede correr, obligar a un solo proveedor es obligar a un gasto.
 *
 * Entras a una sala solo con tu nombre: ver el preview, leer el chat y platicar
 * no cuestan nada. La key hace falta únicamente para pedirle cosas a un agente,
 * y se pide cuando la necesitas — no en la puerta.
 *
 * Sobre guardarla: localStorage está atado al origen, así que solo esta página
 * la lee (el preview vive en otro puerto = otro origen, no la alcanza). Es el
 * mismo nivel que tu .env o el token del CLI de gh: en claro, en tu máquina.
 * Por eso existe "Olvidar" — para compartir pantalla o usar una compu ajena — y
 * por eso nunca se muestra completa.
 */

const STORAGE_KEY = "multi.credencial";

export interface Credencial {
  provider: string;
  key: string;
  model?: string;
}

/**
 * Los proveedores, con cómo se ve su key y qué modelos sugerir. Espejo de
 * `server/src/agent/providers/profiles.ts` — el server valida, esto solo guía.
 */
const PROVEEDORES: Record<
  string,
  { label: string; hint: string; url?: string; modelos: string[] }
> = {
  anthropic: {
    label: "Anthropic (Claude)",
    hint: "sk-ant-…",
    url: "https://console.anthropic.com/settings/keys",
    modelos: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"],
  },
  // Verificados contra https://openrouter.ai/api/v1/models (julio 2026). Los
  // gratis van primero: son la puerta de entrada para quien no quiere pagar.
  openrouter: {
    label: "OpenRouter (muchos modelos)",
    hint: "sk-or-v1-…",
    url: "https://openrouter.ai/keys",
    modelos: [
      "nvidia/nemotron-3-ultra-550b-a55b:free",
      "google/gemma-4-31b-it:free",
      "google/gemma-4-26b-a4b-it:free",
      "anthropic/claude-opus-5",
      "openai/gpt-5.6-terra",
      "google/gemini-3.1-pro-preview",
      "deepseek/deepseek-v4-pro",
    ],
  },
  openai: {
    label: "OpenAI",
    hint: "sk-…",
    url: "https://platform.openai.com/api-keys",
    modelos: ["gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.6-sol"],
  },
  groq: {
    label: "Groq (rápido)",
    hint: "gsk_…",
    url: "https://console.groq.com/keys",
    modelos: ["llama-3.3-70b-versatile"],
  },
  deepseek: {
    label: "DeepSeek",
    hint: "sk-…",
    url: "https://platform.deepseek.com/api_keys",
    modelos: ["deepseek-chat", "deepseek-reasoner"],
  },
  ollama: {
    label: "Ollama (en tu máquina)",
    hint: "cualquier cosa: Ollama no pide key",
    modelos: ["gemma3", "qwen2.5-coder"],
  },
};

export function loadStoredCredencial(): Credencial | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw);
    return typeof c?.key === "string" && typeof c?.provider === "string" ? c : null;
  } catch {
    return null; // modo privado, storage bloqueado o guardado corrupto
  }
}

function store(c: Credencial): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(c));
  } catch {
    // Sin storage la credencial sigue sirviendo en esta sesión; solo no persiste.
  }
}

function forget(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // nada que borrar
  }
}

/** "sk-ant-…4f2a" — suficiente para reconocerla, inútil para copiarla. */
function enmascarar(key: string): string {
  return key.length > 8 ? `${key.slice(0, 7)}…${key.slice(-4)}` : "…";
}

export function KeyPanel(props: {
  actual: Credencial | null;
  abiertoPorDefecto: boolean;
  error: string | null;
  onGuardar: (c: Credencial) => void;
  onOlvidar: () => void;
}) {
  const [abierto, setAbierto] = useState(props.abiertoPorDefecto);
  const [provider, setProvider] = useState(props.actual?.provider ?? "openrouter");
  const [key, setKey] = useState("");
  const [model, setModel] = useState(props.actual?.model ?? "");
  /** Catálogo real del proveedor (si publica uno). Vacío = usar los sugeridos. */
  const [catalogo, setCatalogo] = useState<string[]>([]);

  const perfil = PROVEEDORES[provider] ?? PROVEEDORES.openrouter;

  // El catálogo se pide al proveedor en vez de mantener una lista a mano, que
  // envejece: OpenRouter tenía 341 modelos el día que se escribió esto.
  useEffect(() => {
    let vigente = true;
    setCatalogo([]);
    fetch(`${SERVER_URL}/providers/${provider}/models`)
      .then((r) => r.json())
      .then((d: { models?: Array<{ id: string; free?: boolean }> }) => {
        if (!vigente || !d.models?.length) return;
        // Los gratis primero: es lo que busca quien no quiere pagar.
        const ordenados = [...d.models].sort((a, b) => Number(b.free) - Number(a.free));
        setCatalogo(ordenados.map((m) => m.id));
      })
      .catch(() => {
        /* sin catálogo se usan los sugeridos del perfil */
      });
    return () => {
      vigente = false;
    };
  }, [provider]);

  /** Lo que se ofrece en el desplegable: el catálogo real, o los sugeridos. */
  const sugerencias = catalogo.length > 0 ? catalogo : perfil.modelos;

  const guardar = () => {
    const k = key.trim();
    if (!k) return;
    const c: Credencial = { provider, key: k, model: model.trim() || sugerencias[0] || perfil.modelos[0] };
    store(c);
    props.onGuardar(c);
    setKey(""); // no se queda en el DOM más de lo necesario
  };

  const olvidar = () => {
    forget();
    props.onOlvidar();
  };

  if (!abierto) {
    return (
      <button
        className={`key-chip ${props.actual ? "listo" : "falta"}`}
        onClick={() => setAbierto(true)}
        title={props.actual ? `${props.actual.provider} · ${props.actual.model ?? ""}` : "necesaria para invocar agentes"}
      >
        {props.actual ? PROVEEDORES[props.actual.provider]?.label.split(" ")[0] ?? "listo" : "poner mi key"}
      </button>
    );
  }

  return (
    <div className="key-panel">
      <div className="key-cab">
        <span>Tu modelo</span>
        <button className="key-x" onClick={() => setAbierto(false)}>
          cerrar
        </button>
      </div>

      {props.actual ? (
        <>
          <div className="key-puesta">
            <div className="key-puesta-info">
              <code>{enmascarar(props.actual.key)}</code>
              <span className="key-puesta-modelo">
                {PROVEEDORES[props.actual.provider]?.label ?? props.actual.provider}
                {props.actual.model ? ` · ${props.actual.model}` : ""}
              </span>
            </div>
            <button className="key-olvidar" onClick={olvidar}>
              Cambiar
            </button>
          </div>
          <p className="key-nota">
            Guardado en este navegador: sirve en todas tus salas y sigue aquí mañana.
            Nadie más en la sala lo ve.
          </p>
        </>
      ) : (
        <>
          <label className="key-campo">
            <span>Proveedor</span>
            <select
              className="key-select"
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value);
                setModel(""); // el modelo del anterior no aplica al nuevo
              }}
            >
              {Object.entries(PROVEEDORES).map(([id, p]) => (
                <option key={id} value={id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>

          <label className="key-campo">
            <span>Key</span>
            <input
              className="key-input"
              type="password"
              placeholder={perfil.hint}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") guardar();
                if (e.key === "Escape") setAbierto(false);
              }}
              autoFocus
            />
          </label>

          <label className="key-campo">
            <span>Modelo</span>
            {/* Un <select> y no un <input list>: el datalist con los 341 modelos
                de OpenRouter hacía que Chrome dejara su tooltip nativo flotando
                encima del panel. Con select el navegador maneja la lista larga
                como lo que es, y de paso no se puede escribir un id inválido. */}
            <select
              className="key-select"
              value={model || sugerencias[0] || ""}
              onChange={(e) => setModel(e.target.value)}
            >
              {sugerencias.map((m) => (
                <option key={m} value={m}>
                  {etiquetaModelo(m)}
                </option>
              ))}
            </select>
          </label>

          <p className="key-nota">
            Cada quien usa el suyo: lo que le pidas al agente lo pagas tú, no la sala.
          </p>

          <button className="key-guardar" onClick={guardar} disabled={!key.trim()}>
            Guardar
          </button>

          {perfil.url && (
            <a className="key-link" href={perfil.url} target="_blank" rel="noreferrer">
              ¿De dónde saco una key de {perfil.label.split(" ")[0]}?
            </a>
          )}
        </>
      )}

      {props.error && <div className="key-error">{props.error}</div>}
    </div>
  );
}

/**
 * Cómo se lee un modelo en la lista. Marca los gratis: con cientos de opciones,
 * saber cuáles no cuestan es lo primero que alguien busca.
 */
function etiquetaModelo(id: string): string {
  return id.endsWith(":free") ? `${id.slice(0, -5)}  ·  gratis` : id;
}
