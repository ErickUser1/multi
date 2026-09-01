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
// Los cuatro de antes eran naranjas casi identicos y uno repetia el color de
// una persona: con dos agentes en la sala no se sabia cual hablaba. Ahora son
// una familia calida propia, distinta de la de la gente.
const AGENT_COLORS = ["#ff4d1c", "#ff8c42", "#e0574f", "#ffb347"];

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

/**
 * Qué están haciendo los demás agentes de la sala, para contárselo al que
 * empieza un turno.
 *
 * El caso que resuelve, visto en una sesión real: alguien lanza un agente que se
 * pone a instalar dependencias; segundos después alguien lanza otro, que mira el
 * workspace, lo ve vacío (el primero todavía no escribe nada) y se pone a montar
 * el proyecto también. Dos agentes haciendo lo mismo desde el segundo cero.
 *
 * Es el problema del que nació Multi — divergir por no ver lo que hace el otro —
 * aplicado a los agentes. Se resolvió para los humanos (ven el chat, el preview,
 * los cursores) y se pasó por alto aquí.
 *
 * Se manda un RESUMEN, no la conversación del otro: lo segundo es caro y en su
 * mayoría ruido. Basta con quién más trabaja, en qué, y qué archivos tocó.
 */
export function resumenDeOtros(
  registro: AgentRegistry,
  yo: string,
  archivos: Array<{ agentId: string; path: string; escribiendoAhora: boolean }>,
  /**
   * Lo último que dijo cada agente en el chat. Es el mismo texto que la sala ya
   * leyó — no hay canal privado entre agentes, todos ven lo mismo.
   *
   * Vale más de lo que parece: el resumen dice QUÉ archivo toca el otro, pero no
   * las decisiones que tomó ("los datos van en src/data/personajes.ts, tipados
   * así"). Eso solo está en lo que contó, y ahorra que el siguiente lo descubra
   * leyendo o lo reinvente distinto.
   */
  ultimoMensaje?: Map<string, string>,
): string | null {
  /**
   * Los que están trabajando MÁS los que acaban de terminar dejando rastro.
   *
   * Un agente pasa a `idle` en cuanto cierra su turno, así que filtrar por estado
   * lo hacía desaparecer del resumen al segundo de haber hecho justo lo que el
   * siguiente necesita saber. Pasó de verdad: uno construyó el nivel de un juego,
   * terminó, y a los pocos minutos otro empezó a construir su propia versión.
   *
   * Quién filtra ahora es el tiempo, no el estado: `archivos` ya viene acotado a
   * los últimos dos minutos (`trabajoRecienteDeOtros`), así que un agente que
   * terminó hace rato desaparece solo. Para lo que quede fuera de esa ventana
   * está `git log`, que guarda quién hizo qué en cada turno.
   */
  const otros = registro
    .list()
    .filter((a) => a.id !== yo)
    .filter((a) => a.state !== "idle" || archivos.some((f) => f.agentId === a.id));
  if (otros.length === 0) return null;

  const lineas = otros.map((a) => {
    const suyos = archivos.filter((f) => f.agentId === a.id);
    const enVuelo = suyos.filter((f) => f.escribiendoAhora).map((f) => f.path);
    const tocados = suyos.filter((f) => !f.escribiendoAhora).map((f) => f.path);

    // Terminado vs trabajando cambia qué hacer: lo del que sigue adentro se
    // respeta, lo del que ya salió se puede usar sin esperar a nadie.
    const estado = a.state === "idle" ? " (ya terminó)" : "";
    const partes = [`${a.name}${estado}: ${a.task ?? "trabajando"}`];
    if (enVuelo.length) partes.push(`  escribiendo ahora: ${enVuelo.join(", ")}`);
    if (tocados.length) partes.push(`  ya tocó: ${tocados.slice(0, 8).join(", ")}`);

    const dijo = ultimoMensaje?.get(a.id);
    if (dijo) partes.push(`  dijo: "${recorta(dijo, 300)}"`);
    return partes.join("\n");
  });

  return [
    "<otros_agentes>",
    "Otros agentes están trabajando en este proyecto, o acaban de trabajar en él:",
    "",
    ...lineas,
    "",
    "No rehagas lo que otro ya hizo ni lo que está haciendo. Si alguien está montando",
    "el proyecto, espera a que termine o trabaja en otra parte. Un archivo que otro",
    "está escribiendo en este momento: déjalo. Uno que ya soltó: léelo antes de",
    "tocarlo, porque cambió desde la última vez que lo viste.",
    "",
    "Esto cubre los últimos minutos. Si lo que te piden pudo hacerse antes, `git log`",
    "dice qué hizo cada agente en cada turno.",
    "</otros_agentes>",
  ].join("\n");
}

/** Recorta a lo que quepa sin comerse el contexto del turno. */
function recorta(s: string, max: number): string {
  const limpio = s.replace(/\s+/g, " ").trim();
  return limpio.length > max ? `${limpio.slice(0, max)}…` : limpio;
}
