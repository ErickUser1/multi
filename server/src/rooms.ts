import { createWorkspace, type Workspace } from "./engine/workspace.js";
import { startPreview, detectLaunch, type Preview } from "./engine/preview.js";
import {
  isDockerAvailable,
  startContainer,
  stopContainer,
  type Container,
} from "./engine/container.js";
import { containerRunner, localRunner, type Runner } from "./engine/runner.js";
import type { Message } from "./agent/providers/types.js";
import { AgentRegistry } from "./engine/agents.js";
import { RunCoordinator } from "./engine/coordinator.js";
import { sweepOrphans, type Turn } from "./engine/turns.js";
import { getStorage } from "./storage/index.js";

/** Un miembro humano conectado a la sala. */
export interface Member {
  socketId: string;
  name: string;
  color: string;
  /**
   * Si esta persona puede invocar agentes (trajo su API key). Se muestra en la
   * presencia para saber quién puede pedirle cosas al agente y quién solo mira.
   * Es un booleano a propósito: la key jamás sale del server.
   */
  canInvoke?: boolean;
}

/** Un elemento del preview seleccionado (capturado por el inspector). */
export interface SelectedElement {
  /** Selector CSS único, para que el agente encuentre el código con grep. */
  selector: string;
  tag: string;
  /** Texto visible del elemento (recortado). */
  text: string;
  /** Ruta legible tipo "main > .app-cuerpo > button.btn-pedido". */
  path: string;
}

/** Estado de una sala en memoria (v1: no persiste; Fase 7 lo lleva a Supabase). */
export interface Room {
  id: string;
  workspace: Workspace;
  preview: Preview | null;
  /** Hay un arranque de preview en curso (evita dos npm install a la vez). */
  previewBooting?: boolean;
  /** El contenedor que aísla esta sala. null si se está corriendo sin Docker. */
  container?: Container | null;
  /** Dónde se ejecutan los comandos del agente (contenedor o local). */
  runner?: Runner;
  members: Map<string, Member>;
  /** Historial de chat POR AGENTE (cada agente tiene su propia conversación). */
  histories: Map<string, Message[]>;
  /** Selección actual de cada miembro (socketId → elemento). Para mostrarlas a todos. */
  selections: Map<string, SelectedElement>;
  /** Los agentes de esta sala, como jugadores visibles. */
  agents: AgentRegistry;
  /** Un drain activo por AGENTE (no por sala) → paralelo real. */
  coordinator: RunCoordinator;
  /** Turnos que quedaron a medias por un crash; el humano decide qué hacer. */
  orphanTurns?: Turn[];
}

const rooms = new Map<string, Room>();

const COLORS = ["#b9a8e3", "#c393c9", "#7fa3d8", "#8fb573", "#ffc37a", "#d95d63"];
const ADJ = ["taco", "chido", "vibe", "noche", "lofi", "pixel", "nube", "compa"];
const NOUN = ["fiesta", "sala", "jam", "build", "crew", "party", "lab", "zona"];

function genId(): string {
  const a = ADJ[Math.floor(Math.random() * ADJ.length)];
  const n = NOUN[Math.floor(Math.random() * NOUN.length)];
  const num = Math.floor(Math.random() * 90) + 10;
  return `${a}-${n}-${num}`;
}

export function colorFor(index: number): string {
  return COLORS[index % COLORS.length];
}

/**
 * Crea una sala: genera id, crea su workspace (proyecto de prueba sembrado),
 * instala deps y arranca el preview. Devuelve la sala lista.
 */
export async function createRoom(): Promise<Room> {
  const storage = await getStorage();
  let id = genId();
  while (rooms.has(id) || (await storage.getRoom(id))) id = genId();

  const workspace = await createWorkspace(id, { clean: true });

  const room: Room = {
    id,
    workspace,
    preview: null,
    members: new Map(),
    histories: new Map(),
    selections: new Map(),
    agents: new AgentRegistry(),
    coordinator: new RunCoordinator(),
  };
  rooms.set(id, room);

  const now = Date.now();
  await storage.createRoom({ id, workspaceDir: workspace.dir, createdAt: now, lastActiveAt: now });

  // Instalar deps + arrancar preview en background (no bloquea la creación).
  void bootPreview(room);

  return room;
}

/**
 * Despierta una sala que existe en la BD pero no está en memoria (el server
 * reinició). El proyecto ya vive en disco con su git; aquí se reconstruye el
 * estado de la sala y se vuelve a arrancar su preview.
 */
export async function wakeRoom(id: string): Promise<Room | null> {
  if (rooms.has(id)) return rooms.get(id)!;

  const storage = await getStorage();
  const stored = await storage.getRoom(id);
  if (!stored) return null;

  const room: Room = {
    id,
    // El workspace ya existe en disco: NO se re-siembra ni se limpia.
    workspace: await createWorkspace(id),
    preview: null,
    members: new Map(),
    histories: new Map(),
    selections: new Map(),
    agents: new AgentRegistry(),
    coordinator: new RunCoordinator(),
  };
  rooms.set(id, room);

  // Recuperar los agentes que ya vivían en la sala, con sus conversaciones.
  // Sin esto cada reinicio del server borraba el equipo: el siguiente agente
  // volvía a llamarse "agente-1" y el menú de menciones salía vacío.
  const agentIds = await storage.listAgentIds(id);
  if (agentIds.length > 0) {
    room.agents.restore(agentIds);
    for (const agentId of agentIds) {
      room.histories.set(agentId, await storage.getAgentHistory(id, agentId));
    }
  }

  await storage.touchRoom(id);
  void bootPreview(room);
  return room;
}

/** Carga el índice de salas al arrancar (sin despertarlas: eso es perezoso). */
export async function loadRoomIndex(): Promise<number> {
  const storage = await getStorage();
  const list = await storage.listRooms();
  return list.length;
}

/**
 * Prepara la sala y arranca su preview SI ya hay proyecto.
 *
 * Una sala recién creada está vacía: no hay nada que levantar, y eso es normal
 * (el agente todavía no scaffoldea). No es error ni espera indefinida — el
 * preview arranca solo cuando aparezca algo, vía `maybeStartPreview`.
 */
async function bootPreview(room: Room): Promise<void> {
  try {
    // Barrido de huérfanos: turnos que quedaron "running" de un server muerto.
    // NO se decide por el humano — solo se marcan y se avisan (ver DESIGN.md).
    const orphans = await sweepOrphans(room.workspace.dir);
    if (orphans.length > 0) {
      console.log(`[sala ${room.id}] ${orphans.length} turno(s) huérfano(s) detectado(s)`);
      room.orphanTurns = orphans;
    }

    await maybeStartPreview(room);
  } catch (err) {
    console.error(`[sala ${room.id}] falló el arranque:`, err);
  }
}

/**
 * Arranca el preview si el proyecto ya se puede levantar. Idempotente y seguro
 * de llamar seguido: se invoca cuando el agente termina un turno, porque es ahí
 * cuando pudo haber aparecido el proyecto.
 *
 * Devuelve la URL si quedó corriendo, null si todavía no hay qué levantar.
 */
export async function maybeStartPreview(room: Room): Promise<string | null> {
  if (room.preview) return room.preview.url;
  if (room.previewBooting) return null; // ya hay un arranque en curso

  const launch = await detectLaunch(room.workspace.dir);
  if (!launch) return null; // la sala sigue vacía: normal

  room.previewBooting = true;
  try {
    const runner = await ensureRunner(room);
    // El agente pudo instalar deps él mismo; esto las completa si faltan.
    // Corre por el runner: dentro del contenedor si lo hay.
    await runner.exec("npm install", { timeoutMs: 600_000, maxOutput: 4000 });

    room.preview = room.container?.publishedPort
      ? await startPreview(room.workspace, launch, {
          roomId: room.id,
          internalPort: INTERNAL_DEV_PORT,
          publishedPort: room.container.publishedPort,
        })
      : await startPreview(room.workspace, launch);

    console.log(`[sala ${room.id}] preview listo en ${room.preview.url}`);
    return room.preview.url;
  } catch (err) {
    console.error(`[sala ${room.id}] falló el preview:`, err);
    return null;
  } finally {
    room.previewBooting = false;
  }
}

/**
 * El puerto donde escucha el dev server DENTRO del contenedor.
 *
 * Fijo a propósito: adentro cada sala está sola, así que no hay con quién
 * chocar. Docker lo publica en un puerto libre del host, y ese es el que varía.
 */
const INTERNAL_DEV_PORT = 5173;

/**
 * El runner de la sala: dónde corren los comandos del agente.
 *
 * Con Docker, arranca (o reusa) el contenedor de la sala. Sin Docker, cae al
 * runner local — el server ya avisó al arrancar que no hay aislamiento.
 */
export async function ensureRunner(room: Room): Promise<Runner> {
  if (room.runner) return room.runner;

  if (await isDockerAvailable()) {
    try {
      room.container = await startContainer(room.id, room.workspace.dir, INTERNAL_DEV_PORT);
      room.runner = containerRunner(room.id);
      console.log(`[sala ${room.id}] contenedor listo (${room.container.name})`);
      return room.runner;
    } catch (err) {
      // Que Docker exista pero falle NO debe dejar la sala muerta: se avisa
      // fuerte y se sigue sin aislamiento, igual que si no estuviera instalado.
      console.error(`[sala ${room.id}] no se pudo crear el contenedor, sigue SIN aislar:`, err);
    }
  }

  room.runner = localRunner(room.workspace.dir);
  return room.runner;
}

/**
 * Decide si un mensaje del chat es PLÁTICA o una ORDEN, y a quién va dirigida.
 *
 * Regla central (ver DESIGN.md): el chat es para humanos; el agente solo
 * despierta si lo llaman. Sin esto no puedes hablar con tu compa sin que el
 * agente se ponga a trabajar — y esa plática es el corazón del producto.
 */
export type ChatIntent =
  | { kind: "talk" }
  | { kind: "spawn"; task: string }
  | { kind: "address"; agentName: string; task: string };

export function parseIntent(text: string, hasAnchor: boolean): ChatIntent {
  const trimmed = text.trim();
  const m = trimmed.match(/^@([a-z0-9-]+)\s*([\s\S]*)$/i);

  if (m) {
    const target = m[1].toLowerCase();
    const rest = m[2].trim();
    // "@agente ..." (genérico) → agente nuevo. "@agente-2 ..." → ese agente.
    if (target === "agente") return { kind: "spawn", task: rest || trimmed };
    return { kind: "address", agentName: target, task: rest || trimmed };
  }

  // Un elemento anclado ya expresa la intención de ordenar: el click implica @.
  if (hasAnchor) return { kind: "spawn", task: trimmed };

  return { kind: "talk" };
}

export function getRoom(id: string): Room | undefined {
  return rooms.get(id);
}

export function allRooms(): Room[] {
  return [...rooms.values()];
}

/**
 * Apaga los previews y contenedores de todas las salas. Se llama al apagar el
 * server para no dejar procesos huérfanos ocupando puertos (causaba 502 en el
 * proxy al reiniciar: el asignador reusaba un puerto que un vite muerto seguía
 * tomando) ni contenedores comiendo RAM.
 */
export async function stopAllPreviews(): Promise<void> {
  await Promise.all(
    allRooms().map(async (r) => {
      await r.preview?.stop();
      if (r.container) await stopContainer(r.id);
    }),
  );
}

export function addMember(room: Room, socketId: string, name: string): Member {
  const member: Member = {
    socketId,
    name,
    color: colorFor(room.members.size),
  };
  room.members.set(socketId, member);
  return member;
}

export function removeMember(room: Room, socketId: string): void {
  room.members.delete(socketId);
}

export function membersList(room: Room): Member[] {
  return [...room.members.values()];
}
