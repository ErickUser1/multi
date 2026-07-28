import { useState } from "react";

/**
 * Tu API key.
 *
 * Es TUYA, no de la sala: se configura una vez y sirve en todas. Vive en este
 * navegador (localStorage), así que sigue ahí mañana y en la sala que crees
 * después. Sin cuentas todavía, el navegador es el único lugar donde puede
 * vivir algo "del usuario".
 *
 * Entras a una sala solo con tu nombre: ver el preview, leer el chat y platicar
 * no cuestan nada. La key hace falta únicamente para pedirle cosas a un agente,
 * y se pide cuando la necesitas — no en la puerta.
 *
 * Sobre guardarla: localStorage está atado al origen, así que solo esta página
 * la lee (el preview vive en otro puerto = otro origen, no la alcanza). Es el
 * mismo nivel que tu .env o el token del CLI de gh: en claro, en tu máquina.
 * Por eso existe "Olvidar" — para prestar la compu o compartir pantalla — y por
 * eso nunca se muestra completa.
 */

const STORAGE_KEY = "multi.anthropic_key";

/** La key guardada en este navegador, si hay. */
export function loadStoredKey(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null; // modo privado o storage bloqueado
  }
}

function storeKey(key: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, key);
  } catch {
    // Sin storage la key sigue funcionando en esta sesión; solo no persiste.
  }
}

function forgetKey(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // nada que borrar
  }
}

/** "sk-ant-…4f2a" — suficiente para reconocerla, inútil para copiarla. */
function enmascarar(key: string): string {
  return `sk-ant-…${key.slice(-4)}`;
}

export function KeyPanel(props: {
  /** La key que está en uso (ya validada por el server), o null. */
  keyActual: string | null;
  /** Se abre solo cuando el server avisó que hace falta. */
  abiertoPorDefecto: boolean;
  error: string | null;
  onGuardar: (key: string) => void;
  onOlvidar: () => void;
}) {
  const [abierto, setAbierto] = useState(props.abiertoPorDefecto);
  const [valor, setValor] = useState("");

  const guardar = () => {
    const k = valor.trim();
    if (!k) return;
    storeKey(k);
    props.onGuardar(k);
    setValor(""); // no se queda en el DOM más de lo necesario
  };

  const olvidar = () => {
    forgetKey();
    props.onOlvidar();
  };

  if (!abierto) {
    return (
      <button
        className={`key-chip ${props.keyActual ? "listo" : "falta"}`}
        onClick={() => setAbierto(true)}
        title={props.keyActual ? "tu key está puesta" : "necesaria para invocar agentes"}
      >
        {props.keyActual ? "tu key" : "poner mi key"}
      </button>
    );
  }

  return (
    <div className="key-panel">
      <div className="key-cab">
        <span>Tu API key</span>
        <button className="key-x" onClick={() => setAbierto(false)}>
          cerrar
        </button>
      </div>

      {props.keyActual ? (
        <>
          <div className="key-puesta">
            <code>{enmascarar(props.keyActual)}</code>
            <button className="key-olvidar" onClick={olvidar}>
              Olvidar
            </button>
          </div>
          <p className="key-nota">
            Guardada en este navegador: sirve en todas tus salas y sigue aquí mañana.
            Nadie más en la sala la ve. Bórrala si vas a prestar la compu o compartir pantalla.
          </p>
        </>
      ) : (
        <>
          <p className="key-nota">
            Cada quien usa la suya: lo que le pidas al agente lo pagas tú, no la sala.
            Se guarda en este navegador, así la pones una sola vez.
          </p>

          <div className="key-fila">
            <input
              className="key-input"
              type="password"
              placeholder="sk-ant-..."
              value={valor}
              onChange={(e) => setValor(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") guardar();
                if (e.key === "Escape") setAbierto(false);
              }}
              autoFocus
            />
            <button className="key-guardar" onClick={guardar} disabled={!valor.trim()}>
              Guardar
            </button>
          </div>

          <a
            className="key-link"
            href="https://console.anthropic.com/settings/keys"
            target="_blank"
            rel="noreferrer"
          >
            ¿De dónde saco una?
          </a>
        </>
      )}

      {props.error && <div className="key-error">{props.error}</div>}
    </div>
  );
}
