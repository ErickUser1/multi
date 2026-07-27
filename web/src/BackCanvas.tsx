import { useEffect, useState } from "react";
import { SERVER_URL } from "./socket.js";

/**
 * El back visual: el tab "El back".
 *
 * El backend deja de ser una caja negra. Cada endpoint es una card con
 * semáforo, y el estado se ve cambiar mientras el agente trabaja.
 */

type EndpointStatus = "faltante" | "conectado" | "huerfano";

interface CallSite {
  file: string;
  line: number;
}

export interface Endpoint {
  id: string;
  method: string;
  path: string;
  status: EndpointStatus;
  calls: CallSite[];
  definedAt: CallSite | null;
}

const ETIQUETA: Record<EndpointStatus, string> = {
  faltante: "el front lo llama, pero no existe todavía",
  conectado: "existe y el front lo usa",
  huerfano: "existe, pero nadie lo llama",
};

export function BackCanvas(props: {
  roomId: string;
  /** Cambia cuando algún archivo del workspace cambió: hay que re-analizar. */
  version: number;
  /** Anclar el endpoint al chat, igual que se ancla un elemento del preview. */
  onAnclar: (e: Endpoint) => void;
}) {
  const [endpoints, setEndpoints] = useState<Endpoint[] | null>(null);
  const [abierto, setAbierto] = useState<string | null>(null);

  useEffect(() => {
    let vigente = true;
    fetch(`${SERVER_URL}/rooms/${props.roomId}/api-map`)
      .then((r) => r.json())
      .then((d) => {
        if (vigente) setEndpoints(d.endpoints ?? []);
      })
      .catch(() => {
        if (vigente) setEndpoints([]);
      });
    // El mapa se re-pide en cada cambio; si llegan dos seguidos, la respuesta
    // vieja no debe pisar a la nueva.
    return () => {
      vigente = false;
    };
  }, [props.roomId, props.version]);

  if (endpoints === null) {
    return <div className="back-vacio">leyendo el proyecto…</div>;
  }

  if (endpoints.length === 0) {
    return (
      <div className="back-vacio">
        <p>Todavía no hay nada del lado del servidor.</p>
        <p className="back-vacio-sub">
          Cuando el front llame a una API o el agente cree un endpoint, aparece aquí.
        </p>
      </div>
    );
  }

  const faltantes = endpoints.filter((e) => e.status === "faltante").length;

  return (
    <div className="back-canvas">
      {faltantes > 0 && (
        <div className="back-resumen">
          {faltantes === 1
            ? "1 endpoint que el front llama todavía no existe"
            : `${faltantes} endpoints que el front llama todavía no existen`}
        </div>
      )}

      <div className="back-grid">
        {endpoints.map((e) => (
          <Card
            key={e.id}
            endpoint={e}
            abierto={abierto === e.id}
            onToggle={() => setAbierto(abierto === e.id ? null : e.id)}
            onAnclar={() => props.onAnclar(e)}
          />
        ))}
      </div>
    </div>
  );
}

function Card(props: {
  endpoint: Endpoint;
  abierto: boolean;
  onToggle: () => void;
  onAnclar: () => void;
}) {
  const e = props.endpoint;
  return (
    <div className={`ep-card ${e.status}`}>
      <button className="ep-head" onClick={props.onToggle}>
        <span className={`ep-metodo m-${e.method.toLowerCase()}`}>{e.method}</span>
        <span className="ep-path">{e.path}</span>
        <span className={`ep-semaforo ${e.status}`} title={ETIQUETA[e.status]} />
      </button>

      <div className="ep-estado">{ETIQUETA[e.status]}</div>

      {props.abierto && (
        <div className="ep-detalle">
          {e.definedAt ? (
            <div className="ep-linea">
              <span className="ep-k">vive en</span>
              <code>
                {e.definedAt.file}:{e.definedAt.line}
              </code>
            </div>
          ) : (
            <div className="ep-linea ep-falta">sin implementación en el proyecto</div>
          )}

          {e.calls.length > 0 ? (
            <div className="ep-linea">
              <span className="ep-k">lo llama</span>
              <span className="ep-calls">
                {e.calls.map((c) => (
                  <code key={`${c.file}:${c.line}`}>
                    {c.file}:{c.line}
                  </code>
                ))}
              </span>
            </div>
          ) : (
            <div className="ep-linea ep-falta">nadie lo llama desde el front</div>
          )}

          <button className="ep-anclar" onClick={props.onAnclar}>
            {e.status === "faltante" ? "Pedirle al agente que lo cree" : "Hablar de este endpoint"}
          </button>
        </div>
      )}
    </div>
  );
}
