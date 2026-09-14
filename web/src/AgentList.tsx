import { useState } from "react";
import type { Agent } from "./socket.js";
import { useTextos, type Textos } from "./i18n.js";

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
  const { t } = useTextos();
  return (
    <div className={`agent-row agent-${agent.state}`}>
      <span className="agent-dot" style={{ background: agent.color }} />
      <span className="agent-name" style={{ color: agent.color }}>
        {agent.name}
      </span>
      <span className="agent-status">{textoDeEstado(agent, t)}</span>
    </div>
  );
}

/**
 * Qué está haciendo un agente, en una línea.
 *
 * Se exporta porque el chat pinta lo mismo mientras el agente todavía no emite
 * nada: el mismo hecho contado distinto en dos lugares de la misma pantalla se
 * lee como dos cosas.
 */
export function textoDeEstado(a: Agent, t: Textos, conTarea = true): string {
  switch (a.state) {
    case "working":
      return conTarea && a.task ? truncate(a.task) : t.estadoTrabajando;
    case "waiting":
      // Decir A QUIÉN espera convierte una espera opaca en algo comprensible.
      return a.waitingFor
        ? t.estadoEsperandoA(a.waitingFor.holder ?? t.otroAgente, a.waitingFor.path)
        : t.estadoEsperando;
    case "stuck":
      return t.estadoAtorado;
    default:
      return t.estadoInactivo;
  }
}

function truncate(s: string, n = 42): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > n ? `${clean.slice(0, n)}…` : clean;
}
