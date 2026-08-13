import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
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
import { KeyedMutex } from "./engine/keyed-mutex.js";
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
  const enMemoria = rooms.get(id);
  if (enMemoria) return enMemoria;
  // Serializado por sala: entrar dispara varias peticiones casi a la vez (el
  // join, el historial, el mapa del back). Entre comprobar el Map y registrar
  // la sala hay varios `await` a disco y a la BD, así que las tres la veían
  // ausente, las tres construían una sala nueva y cada una arrancaba SU
  // preview. Cada `rooms.set` pisaba al anterior, y la sala que quedaba en
  // memoria no era la del dev server al que apuntaba el proxy.
  return despertares.run(id, () => despertarSala(id));
}

async function despertarSala(id: string): Promise<Room | null> {
  // Se vuelve a mirar YA con el turno tomado: si otra petición despertó la
  // sala mientras esta hacía fila, no hay nada que hacer.
  const yaEsta = rooms.get(id);
  if (yaEsta) return yaEsta;

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
 *
 * Esto NO emite nada por el socket, a propósito: corre al despertar la sala,
 * cuando todavía no hay nadie conectado a quien avisar. Quien entre después
 * recibe la URL en el `joined`; ese es el canal para este caso.
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
/**
 * Por dónde va el arranque del preview.
 *
 * Se avisa a la sala porque el arranque tarda, y sin esto la gente ve el mismo
 * mensaje de "la sala está vacía" que aparece cuando de verdad no hay proyecto.
 * Una espera que se entiende se siente mucho más corta que una que no.
 */
export type EtapaPreview = "contenedor" | "dependencias" | "servidor";

/**
 * Un arranque de preview a la vez por sala. Salas distintas van en paralelo,
 * que es lo normal: es el mismo KeyedMutex que ya serializa los contenedores.
 */
const arranquesDePreview = new KeyedMutex();

/** Un despertar a la vez por sala, por lo mismo. */
const despertares = new KeyedMutex();

export async function maybeStartPreview(
  room: Room,
  onEtapa?: (etapa: EtapaPreview) => void,
): Promise<string | null> {
  // Serializado por sala: dos caminos piden el preview casi a la vez (wakeRoom
  // al despertarla, y el `join` de quien entra). La bandera de abajo no bastaba
  // porque entre leerla y ponerla hay un `await detectLaunch` que toca disco:
  // los dos la leían en false y los dos arrancaban un dev server.
  //
  // El síntoma era Vite avisando "Port 5173 is in use, trying another one" y
  // quedando DOS por sala, uno en cada puerto. El proxy apunta a uno solo, así
  // que la mitad de las peticiones le pegaban al que no era y el preview salía
  // en blanco o con módulos de un servidor distinto.
  return arranquesDePreview.run(room.id, () => arrancarPreview(room, onEtapa));
}

async function arrancarPreview(
  room: Room,
  onEtapa?: (etapa: EtapaPreview) => void,
): Promise<string | null> {
  if (room.preview) return room.preview.url;
  if (room.previewBooting) return null; // ya hay un arranque en curso

  const launch = await detectLaunch(room.workspace.dir);
  if (!launch) return null; // la sala sigue vacía: normal

  room.previewBooting = true;
  const t0 = Date.now();
  const marca = (etapa: string) =>
    console.log(`[sala ${room.id}] ${etapa}: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  try {
    onEtapa?.("contenedor");
    const runner = await ensureRunner(room);
    marca("contenedor");

    // Instalar SOLO si las dependencias declaradas cambiaron. El agente suele
    // instalar él mismo al scaffoldear, y volver a correr `npm install` sobre un
    // node_modules completo cuesta ~7s verificando lo que ya está — cada vez que
    // alguien entra a la sala, con la gente mirando una pantalla vacía.
    //
    // Se compara por HASH del contenido, no por fechas: un checkout de git o una
    // copia del workspace cambian las fechas sin cambiar nada real, y en /mnt/c
    // las fechas son poco confiables de por sí.
    const huella = await huellaDeps(room.workspace.dir);
    if (huella && huella !== (await huellaInstalada(room.workspace.dir))) {
      onEtapa?.("dependencias");
      await runner.exec("npm install", { timeoutMs: 600_000, maxOutput: 4000 });
      await guardarHuella(room.workspace.dir, huella);
      marca("npm install");
    }

    onEtapa?.("servidor");
    room.preview = room.container?.publishedPort
      ? await startPreview(room.workspace, launch, {
          roomId: room.id,
          internalPort: INTERNAL_DEV_PORT,
          publishedPort: room.container.publishedPort,
        })
      : await startPreview(room.workspace, launch);

    marca("dev server");
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

/**
 * Borra una sala del todo: su proyecto, su contenedor y su rastro en la BD.
 *
 * Es irreversible y es PARA TODOS: la sala es de quien tenga el link, no de
 * quien aprieta el botón. Por eso la confirmación vive en la interfaz, y por eso
 * la Sala ofrece bajarse el .zip antes.
 *
 * El orden importa. Primero se apaga lo que está corriendo (el dev server tiene
 * el workspace abierto y el contenedor lo tiene montado); borrar el directorio
 * con ellos vivos deja procesos escribiendo en archivos que ya no existen y, en
 * el caso del contenedor, un montaje colgado. Al final se saca de memoria, para
 * que nadie la resucite a media limpieza.
 */
export async function deleteRoom(id: string): Promise<boolean> {
  const room = rooms.get(id) ?? (await wakeRoom(id));
  if (!room) return false;

  // Fuera de memoria antes de tocar nada: si alguien pide entrar mientras se
  // borra, se encuentra una sala que ya no existe en vez de una a medio morir.
  rooms.delete(id);

  await room.preview?.stop().catch(() => {});
  if (room.container) await stopContainer(id).catch(() => {});

  // El workspace y lo que cuelga de él: los adjuntos y los turnos viven al lado,
  // como hermanos con el id de la sala por prefijo (workspaces/<id>.adjuntos).
  const dir = room.workspace.dir;
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  await rm(`${dir}.adjuntos`, { recursive: true, force: true }).catch(() => {});
  await rm(`${dir}.turns.json`, { force: true }).catch(() => {});
  await rm(`${dir}.bookmarks.json`, { force: true }).catch(() => {});

  await (await getStorage()).deleteRoom(id);
  return true;
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

/**
 * Huella de las dependencias declaradas: hash de package.json + package-lock.
 *
 * El lock importa tanto como el package: fija las versiones exactas, así que
 * puede cambiar (otra resolución) con un package.json idéntico.
 *
 * Devuelve null si no hay package.json (sala vacía) o si node_modules no existe
 * — ahí hay que instalar sí o sí, sin importar qué diga la huella guardada.
 */
async function huellaDeps(dir: string): Promise<string | null> {
  const pkg = join(dir, "package.json");
  if (!existsSync(pkg)) return null;
  if (!existsSync(join(dir, "node_modules"))) return "sin-node_modules";

  const h = createHash("sha256");
  h.update(await readFile(pkg, "utf8"));
  const lock = join(dir, "package-lock.json");
  if (existsSync(lock)) h.update(await readFile(lock, "utf8"));
  return h.digest("hex");
}

/** La huella de la última instalación exitosa. */
async function huellaInstalada(dir: string): Promise<string | null> {
  const marca = join(dir, "node_modules", ".multi-deps");
  if (!existsSync(marca)) return null;
  try {
    return (await readFile(marca, "utf8")).trim();
  } catch {
    return null;
  }
}

/**
 * Guarda la huella dentro de node_modules a propósito: si alguien borra
 * node_modules, la marca se va con él y la próxima vez se instala. La marca no
 * puede sobrevivir a lo que describe.
 */
async function guardarHuella(dir: string, huella: string): Promise<void> {
  try {
    await writeFile(join(dir, "node_modules", ".multi-deps"), huella, "utf8");
  } catch {
    // Si no se puede escribir, el único costo es instalar de más la próxima vez.
  }
}
