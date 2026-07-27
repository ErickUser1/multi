import { createWorkspace, type Workspace } from "./engine/workspace.js";
import { startPreview, type Preview } from "./engine/preview.js";
import { spawn } from "node:child_process";
import type { Message } from "./agent/providers/types.js";
import { AgentRegistry } from "./engine/agents.js";
import { RunCoordinator } from "./engine/coordinator.js";
import { sweepOrphans, type Turn } from "./engine/turns.js";

/** Un miembro humano conectado a la sala. */
export interface Member {
  socketId: string;
  name: string;
  color: string;
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
  let id = genId();
  while (rooms.has(id)) id = genId();

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

  // Instalar deps + arrancar preview en background (no bloquea la creación).
  void bootPreview(room);

  return room;
}

/** npm install + arranca el preview de la sala. Best-effort, en background. */
async function bootPreview(room: Room): Promise<void> {
  try {
    // Barrido de huérfanos: turnos que quedaron "running" de un server muerto.
    // NO se decide por el humano — solo se marcan y se avisan (ver DESIGN.md).
    const orphans = await sweepOrphans(room.workspace.dir);
    if (orphans.length > 0) {
      console.log(`[sala ${room.id}] ${orphans.length} turno(s) huérfano(s) detectado(s)`);
      room.orphanTurns = orphans;
    }

    await runInstall(room.workspace.dir);
    room.preview = await startPreview(room.workspace);
    console.log(`[sala ${room.id}] preview listo en ${room.preview.url}`);
  } catch (err) {
    console.error(`[sala ${room.id}] falló el preview:`, err);
  }
}

function runInstall(cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", ["install"], { cwd, stdio: "ignore" });
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`npm install salió con code ${code}`)),
    );
    child.once("error", reject);
  });
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
 * Apaga los previews de todas las salas. Se llama al apagar el server para no
 * dejar procesos vite huérfanos ocupando puertos (causaba 502 en el proxy al
 * reiniciar: el asignador reusaba un puerto que un vite muerto seguía tomando).
 */
export async function stopAllPreviews(): Promise<void> {
  await Promise.all(allRooms().map((r) => r.preview?.stop() ?? Promise.resolve()));
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
