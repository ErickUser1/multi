import { useState } from "react";
import type { Agent } from "./socket.js";

/**
 * Lista de agentes de la sala — tres estados visualmente distintos:
 *   working  → trabajando (normal)
 *   waiting  → EN FILA por un archivo: color NEUTRO, dice a quién espera.
 *              NO es alarma; pintarlo de alerta entrenaría a ignorar las reales.
 *   stuck    → atorado de verdad: requiere atención.
 *
 * Los inactivos se pliegan (patrón de Claude Code) para no saturar la vista,
 * pero siguen siendo direccionables con @.
 */
export function AgentList({ agents }: { agents: Agent[] }) {
  const [expandIdle, setExpandIdle] = useState(false);

  const activos = agents.filter((a) => a.state !== "idle");
  const inactivos = agents.filter((a) => a.state === "idle");

  if (agents.length === 0) return null;

  return (
    <div className="agent-list">
      {activos.map((a) => (
        <AgentRow key={a.id} agent={a} />
      ))}

      {inactivos.length > 0 &&
        (expandIdle ? (
          <>
            {inactivos.map((a) => (
              <AgentRow key={a.id} agent={a} />
            ))}
            <div className="agent-fold" onClick={() => setExpandIdle(false)}>
              ▴ ocultar inactivos
            </div>
          </>
        ) : (
          <div className="agent-fold" onClick={() => setExpandIdle(true)}>
            ▸ {inactivos.length} agente{inactivos.length > 1 ? "s" : ""} inactivo
            {inactivos.length > 1 ? "s" : ""}
          </div>
        ))}
    </div>
  );
}

function AgentRow({ agent }: { agent: Agent }) {
  return (
    <div className={`agent-row agent-${agent.state}`}>
      <span className="agent-dot" style={{ background: agent.color }} />
      <span className="agent-name" style={{ color: agent.color }}>
        {agent.name}
      </span>
      <span className="agent-status">{statusText(agent)}</span>
    </div>
  );
}

function statusText(a: Agent): string {
  switch (a.state) {
    case "working":
      return a.task ? truncate(a.task) : "trabajando";
    case "waiting":
      // Decir A QUIÉN espera convierte una espera opaca en algo comprensible.
      return a.waitingFor
        ? `esperando a ${a.waitingFor.holder ?? "otro agente"} (${a.waitingFor.path})`
        : "esperando";
    case "stuck":
      return "atorado — sin avanzar";
    default:
      return "inactivo";
  }
}

function truncate(s: string, n = 42): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > n ? `${clean.slice(0, n)}…` : clean;
}
