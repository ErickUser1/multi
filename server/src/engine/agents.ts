/**
 * Registro de agentes de una sala.
 *
 * Los agentes son JUGADORES visibles: tienen nombre, color y un estado que la
 * sala muestra. Tres estados distintos a propósito (ver DESIGN.md "dos relojes"):
 *   working  → trabajando (normal)
 *   waiting  → EN FILA por un archivo; normal, color neutro, dice a quién espera
 *   stuck    → atorado de verdad; requiere atención
 * Pintar "waiting" como alarma entrenaría a la gente a ignorar las alertas reales.
 */

export type AgentState = "idle" | "working" | "waiting" | "stuck";

export interface Agent {
  id: string;
  /** Nombre corto para mencionar: @agente-1 */
  name: string;
  color: string;
  state: AgentState;
  /** Qué está haciendo (la tarea que le pidieron). */
  task?: string;
  /** Si está esperando: a quién y por qué archivo. */
  waitingFor?: { holder?: string; path: string };
  /** Última señal de vida (para el timeout de trabajo activo). */
  lastActiveAt: number;
  /** Acumulado de tiempo TRABAJANDO (no cuenta esperas de lock). */
  activeMs: number;
  /** Instante en que empezó a esperar (para no contar esa espera como trabajo). */
  waitStartedAt?: number;
}

/** Colores distintos a los de los humanos (ámbar/naranjas = agentes). */
const AGENT_COLORS = ["#ffc37a", "#e8a05f", "#d9b878", "#f0b27a"];

export const MAX_AGENTS_PER_ROOM = 3;

export class AgentRegistry {
  private agents = new Map<string, Agent>();
  private counter = 0;

  /** Crea un agente nuevo. Devuelve null si ya se llegó al límite. */
  spawn(task: string): Agent | null {
    const active = [...this.agents.values()].filter((a) => a.state !== "idle");
    if (active.length >= MAX_AGENTS_PER_ROOM) return null;

    this.counter++;
    const agent: Agent = {
      id: `agente-${this.counter}`,
      name: `agente-${this.counter}`,
      color: AGENT_COLORS[(this.counter - 1) % AGENT_COLORS.length],
      state: "working",
      task,
      lastActiveAt: Date.now(),
      activeMs: 0,
    };
    this.agents.set(agent.id, agent);
    return agent;
  }

  /**
   * Repuebla el registro con los agentes que ya existían en la sala.
   *
   * Se llama al despertar una sala tras un reinicio del server. Sin esto el
   * registro nace vacío con el contador en cero: el siguiente agente se vuelve
   * a llamar "agente-1" (pisando al anterior en el chat), el menú de menciones
   * sale vacío, y pierdes con quién venías conversando.
   *
   * Entran como `idle`: nadie está trabajando después de un reinicio — lo que
   * hubiera quedado a medias lo recoge el barrido de turnos huérfanos.
   */
  restore(ids: string[]): void {
    for (const id of ids) {
      if (this.agents.has(id)) continue;
      const n = Number(id.replace(/\D/g, "")) || this.counter + 1;
      this.agents.set(id, {
        id,
        name: id,
        color: AGENT_COLORS[(n - 1) % AGENT_COLORS.length],
        state: "idle",
        lastActiveAt: Date.now(),
        activeMs: 0,
      });
      // El contador sigue desde el más alto: el próximo no repite nombre.
      if (n > this.counter) this.counter = n;
    }
  }

  get(id: string): Agent | undefined {
    return this.agents.get(id);
  }

  /** Busca por mención: "@agente-2" → el agente 2. */
  findByMention(mention: string): Agent | undefined {
    const clean = mention.replace(/^@/, "").toLowerCase();
    return [...this.agents.values()].find((a) => a.name.toLowerCase() === clean);
  }

  list(): Agent[] {
    return [...this.agents.values()];
  }

  /** El agente empieza a esperar un lock: pausa su reloj de trabajo. */
  startWaiting(id: string, info: { holder?: string; path: string }): void {
    const a = this.agents.get(id);
    if (!a) return;
    a.activeMs += Date.now() - a.lastActiveAt;
    a.state = "waiting";
    a.waitingFor = info;
    a.waitStartedAt = Date.now();
  }

  /** Terminó de esperar: reanuda el reloj de trabajo. */
  endWaiting(id: string): void {
    const a = this.agents.get(id);
    if (!a || a.state !== "waiting") return;
    a.state = "working";
    a.waitingFor = undefined;
    a.waitStartedAt = undefined;
    a.lastActiveAt = Date.now();
  }

  /** Señal de vida (cada tool ejecutada). */
  touch(id: string): void {
    const a = this.agents.get(id);
    if (!a) return;
    if (a.state === "working") {
      a.activeMs += Date.now() - a.lastActiveAt;
    }
    a.lastActiveAt = Date.now();
  }

  setState(id: string, state: AgentState): void {
    const a = this.agents.get(id);
    if (!a) return;
    a.state = state;
    a.lastActiveAt = Date.now();
    if (state !== "waiting") a.waitingFor = undefined;
  }

  finish(id: string): void {
    const a = this.agents.get(id);
    if (!a) return;
    a.state = "idle";
    a.task = undefined;
    a.waitingFor = undefined;
  }

  /**
   * Marca como "stuck" a los que llevan mucho SIN AVANZAR trabajando.
   * Ojo: los que están en "waiting" NO cuentan — están en fila, no atorados.
   */
  detectStuck(timeoutMs: number): Agent[] {
    const now = Date.now();
    const stuck: Agent[] = [];
    for (const a of this.agents.values()) {
      if (a.state !== "working") continue;
      if (now - a.lastActiveAt > timeoutMs) {
        a.state = "stuck";
        stuck.push(a);
      }
    }
    return stuck;
  }
}
