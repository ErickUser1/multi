import Fastify from "fastify";
import cors from "@fastify/cors";
import { Server as SocketServer } from "socket.io";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

import {
  createRoom,
  getRoom,
  addMember,
  removeMember,
  membersList,
  stopAllPreviews,
  parseIntent,
  wakeRoom,
  loadRoomIndex,
  type Room,
  type SelectedElement,
} from "./rooms.js";
import { getStorage } from "./storage/index.js";
import { MAX_AGENTS_PER_ROOM } from "./engine/agents.js";
import { startTurn, commitTurn, failTurn } from "./engine/turns.js";
import { commitAll, discardChanges, diffCommit, revertTo, revertFile } from "./engine/git.js";
import { getHistory, setBookmark } from "./engine/history.js";
import { handlePreviewRequest, handlePreviewUpgrade } from "./engine/proxy.js";
import { runAgent } from "./agent/loop.js";
import { AnthropicProvider } from "./agent/providers/anthropic.js";
import type { ModelProvider } from "./agent/providers/types.js";
import { createDevMock } from "./agent/providers/mock-scenarios.js";

const PORT = Number(process.env.PORT ?? 4000);
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:5173";

await loadEnv();

const fastify = Fastify({ logger: { level: "warn" } });
await fastify.register(cors, { origin: WEB_ORIGIN, credentials: true });

const io = new SocketServer(fastify.server, {
  cors: { origin: WEB_ORIGIN, methods: ["GET", "POST"], credentials: true },
});

fastify.addHook("preClose", (done) => {
  io.local.disconnectSockets(true);
  done();
});

/**
 * Engancha el reverse proxy del preview al http.Server crudo.
 * DEBE llamarse DESPUÉS de fastify.listen() (ahí Fastify ya montó su listener
 * de "request"). Tomamos los listeners existentes (Fastify + socket.io) y los
 * envolvemos: /preview/* → proxy; el resto → listeners originales.
 */
function hookPreviewProxy(): void {
  const rawServer = fastify.server;

  const origRequest = rawServer.listeners("request") as Array<
    (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void
  >;
  rawServer.removeAllListeners("request");
  rawServer.on("request", (req, res) => {
    // handlePreviewRequest decide si le toca (incluye assets de raíz como
    // /@vite/client que resuelve por Referer). Si no, sigue el flujo normal.
    if (handlePreviewRequest(req, res)) return;
    for (const l of origRequest) l(req, res);
  });

  const origUpgrade = rawServer.listeners("upgrade") as Array<
    (req: import("node:http").IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => void
  >;
  rawServer.removeAllListeners("upgrade");
  rawServer.on("upgrade", (req, socket, head) => {
    if (handlePreviewUpgrade(req, socket, head)) return;
    for (const l of origUpgrade) l(req, socket, head);
  });
}

// ── HTTP ────────────────────────────────────────────────────────────────────

fastify.get("/health", async () => ({ status: "ok", service: "multi-server" }));

// Crear sala → devuelve su id. El cliente navega a /sala/:id.
fastify.post("/rooms", async () => {
  const room = await createRoom();
  return { id: room.id };
});

// La línea de tiempo de una sala (alimenta el scrubber).
fastify.get<{ Params: { id: string } }>("/rooms/:id/history", async (req, reply) => {
  const room = getRoom(req.params.id) ?? (await wakeRoom(req.params.id));
  if (!room) return reply.code(404).send({ error: "sala no encontrada" });
  return { entries: await getHistory(room.workspace.dir) };
});

// El diff de un turno — opt-in, no se muestra por defecto.
fastify.get<{ Params: { id: string; hash: string } }>(
  "/rooms/:id/diff/:hash",
  async (req, reply) => {
    const room = getRoom(req.params.id);
    if (!room) return reply.code(404).send({ error: "sala no encontrada" });
    if (!/^[0-9a-f]{7,40}$/i.test(req.params.hash)) {
      return reply.code(400).send({ error: "hash inválido" });
    }
    return { patch: await diffCommit(room.workspace.dir, req.params.hash) };
  },
);

// Info de una sala (para saber la URL del preview al entrar).
fastify.get<{ Params: { id: string } }>("/rooms/:id", async (req, reply) => {
  const room = getRoom(req.params.id);
  if (!room) return reply.code(404).send({ error: "sala no encontrada" });
  return {
    id: room.id,
    previewUrl: room.preview?.url ?? null,
    members: membersList(room),
  };
});

// ── El proveedor de modelo (compartido) ──────────────────────────────────────

/**
 * El proveedor de modelo. Siempre el real en uso normal.
 *
 * MULTI_TEST_MOCK=1 lo cambia por el agente simulado — lo usan SOLO los demos
 * automatizados, para que las verificaciones no gasten API key. El nombre lleva
 * "TEST" a propósito: nadie lo pone por accidente creyendo que es una opción
 * normal, y el arranque lo grita.
 */
function makeProvider(): ModelProvider {
  if (process.env.MULTI_TEST_MOCK === "1") {
    console.warn("\n  *** AGENTE SIMULADO (MULTI_TEST_MOCK=1) — solo para pruebas ***\n");
    return createDevMock();
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (key) return new AnthropicProvider(key);

  console.error(
    [
      "",
      "  Falta ANTHROPIC_API_KEY.",
      "  Ponla en server/.env:   ANTHROPIC_API_KEY=sk-ant-...",
      "",
    ].join("\n"),
  );
  process.exit(1);
}
const provider = makeProvider();

// ── Socket.IO ─────────────────────────────────────────────────────────────

io.on("connection", (socket) => {
  let joinedRoom: Room | null = null;

  socket.on("join", async ({ roomId, name }: { roomId: string; name: string }) => {
    // Si no está en memoria, puede existir en la BD (el server reinició).
    const room = getRoom(roomId) ?? (await wakeRoom(roomId));
    if (!room) {
      socket.emit("error:join", { message: "sala no encontrada" });
      return;
    }
    joinedRoom = room;
    socket.join(roomId);
    const member = addMember(room, socket.id, name || "anónimo");

    // Estado inicial para el que entra, con el chat que ya existía.
    const storage = await getStorage();
    const history = await storage.getMessages(roomId);
    socket.emit("joined", {
      roomId,
      you: member,
      members: membersList(room),
      previewUrl: room.preview?.url ?? null,
      agents: room.agents.list(),
      orphanTurns: room.orphanTurns ?? [],
      messages: history.map((m) => ({
        from: m.author,
        color: m.color,
        role: m.role,
        text: m.text,
        anchoredTo: m.anchoredTo,
      })),
    });
    // Avisar a los demás de la nueva presencia.
    socket.to(roomId).emit("presence", { members: membersList(room) });

    // Si el preview aún no está listo, avisar cuando lo esté.
    if (!room.preview) void notifyPreviewWhenReady(room);
  });

  // Mensaje de chat → lo retransmite y dispara al agente.
  // `anchor` (opcional) es la selección LOCAL del que manda (cuidado 2).
  socket.on("chat", async ({ text, anchor }: { text: string; anchor?: SelectedElement | null }) => {
    const room = joinedRoom;
    if (!room || !text?.trim()) return;
    const member = room.members.get(socket.id);
    if (!member) return;

    // 1) Eco del mensaje humano a toda la sala (con marca de anclaje si aplica).
    void say(room, {
      from: member.name,
      color: member.color,
      role: "human",
      text,
      anchoredTo: anchor ? anchor.path : undefined,
    });

    // 2) ¿Es plática o una orden? El agente solo despierta si lo llaman.
    const intent = parseIntent(text, !!anchor);
    if (intent.kind === "talk") return; // plática entre humanos: nadie despierta

    // Anclaje: prependemos el elemento como texto legible (cuidado 3).
    const withAnchor = (t: string) => (anchor ? `${anchorText(anchor)}\n\n${t}` : t);

    if (intent.kind === "address") {
      // "@agente-2 ..." → join a ese agente (coalescing, no arranca otro loop).
      const target = room.agents.findByMention(intent.agentName);
      if (!target) {
        systemMsg(room, `no existe "${intent.agentName}" en esta sala`);
        return;
      }
      void dispatchAgent(room, target.id, withAnchor(intent.task));
    } else {
      // "@agente ..." o mensaje anclado → agente NUEVO (paralelo real).
      const agent = room.agents.spawn(intent.task);
      if (!agent) {
        systemMsg(room, `ya hay ${MAX_AGENTS_PER_ROOM} agentes trabajando; espera a que alguno termine`);
        return;
      }
      io.to(room.id).emit("agents", { agents: room.agents.list() });
      void dispatchAgent(room, agent.id, withAnchor(intent.task));
    }

    // Al mandar mensaje anclado, limpiar la selección de este miembro (cuidado 4).
    if (anchor) {
      room.selections.delete(socket.id);
      io.to(room.id).emit("select", {
        socketId: socket.id,
        name: member.name,
        color: member.color,
        element: null,
      });
    }
  });

  // Cursor del mouse sobre el escenario → retransmitir a los demás (relay puro).
  socket.on("cursor", (pos: { x: number; y: number }) => {
    const room = joinedRoom;
    if (!room) return;
    const member = room.members.get(socket.id);
    if (!member) return;
    socket.to(room.id).emit("cursor", {
      socketId: socket.id,
      name: member.name,
      color: member.color,
      x: pos.x,
      y: pos.y,
    });
  });

  // Selección de un elemento del preview → visible para todos + guardada en la sala.
  socket.on("select", (sel: SelectedElement | null) => {
    const room = joinedRoom;
    if (!room) return;
    const member = room.members.get(socket.id);
    if (!member) return;
    // Recordar la selección de este miembro (para anclar su próximo mensaje).
    if (sel) room.selections.set(socket.id, sel);
    else room.selections.delete(socket.id);
    io.to(room.id).emit("select", {
      socketId: socket.id,
      name: member.name,
      color: member.color,
      element: sel,
    });
  });

  // ── Historial: previsualizar, regresar, marcar ──────────────────────────

  /**
   * Regresar a un punto: SIEMPRE como commit nuevo, nunca borra historia.
   * Puede ser total o de un solo archivo (revert selectivo).
   */
  socket.on(
    "history:revert",
    async ({ hash, file }: { hash: string; file?: string }) => {
      const room = joinedRoom;
      if (!room || !/^[0-9a-f]{7,40}$/i.test(hash)) return;
      const member = room.members.get(socket.id);
      const author = member?.name ?? "alguien";
      try {
        const newHash = file
          ? await revertFile(room.workspace.dir, hash, file, { author })
          : await revertTo(room.workspace.dir, hash, { author });
        systemMsg(
          room,
          file
            ? `${author} regresó ${file} a un estado anterior`
            : `${author} regresó el proyecto a un estado anterior`,
        );
        io.to(room.id).emit("history:changed", { newHash });
      } catch (err) {
        systemMsg(room, `no se pudo regresar: ${String(err)}`, "#d95d63");
      }
    },
  );

  /** Marcar una versión que importa ("la que funcionaba"). */
  socket.on("history:bookmark", async ({ hash, label }: { hash: string; label: string | null }) => {
    const room = joinedRoom;
    if (!room || !/^[0-9a-f]{7,40}$/i.test(hash)) return;
    await setBookmark(room.workspace.dir, hash, label);
    io.to(room.id).emit("history:changed", {});
  });

  // El humano decide qué hacer con el trabajo que quedó a medias por un crash.
  // Nunca se decide automáticamente: ese trabajo ya está en disco y ya lo vieron
  // todos en el preview (ver DESIGN.md "turnos huérfanos").
  socket.on("orphans:resolve", async ({ action }: { action: "keep" | "revert" }) => {
    const room = joinedRoom;
    if (!room?.orphanTurns?.length) return;
    const member = room.members.get(socket.id);

    try {
      if (action === "keep") {
        const hash = await commitAll(room.workspace.dir, {
          message: "trabajo recuperado de un turno interrumpido",
          author: room.orphanTurns[0].agentId,
        });
        systemMsg(room, `${member?.name ?? "alguien"} guardó el trabajo interrumpido${hash ? "" : " (no había cambios)"}`);
      } else {
        await discardChanges(room.workspace.dir);
        systemMsg(room, `${member?.name ?? "alguien"} volvió al último punto guardado`);
      }
    } catch (err) {
      systemMsg(room, `no se pudo resolver: ${String(err)}`, "#d95d63");
    }

    room.orphanTurns = [];
    io.to(room.id).emit("orphans", { turns: [] });
  });

  socket.on("disconnect", () => {
    if (joinedRoom) {
      removeMember(joinedRoom, socket.id);
      joinedRoom.selections.delete(socket.id);
      socket.to(joinedRoom.id).emit("presence", { members: membersList(joinedRoom) });
      socket.to(joinedRoom.id).emit("cursor:gone", { socketId: socket.id });
    }
  });
});

/** Emite un mensaje a la sala Y lo persiste, para que sobreviva al reinicio. */
async function say(
  room: Room,
  msg: { from: string; color: string; role: "human" | "agent" | "system"; text: string; anchoredTo?: string },
): Promise<void> {
  io.to(room.id).emit("chat:message", msg);
  try {
    const storage = await getStorage();
    await storage.appendMessage({
      roomId: room.id,
      author: msg.from,
      color: msg.color,
      role: msg.role,
      text: msg.text,
      anchoredTo: msg.anchoredTo,
      createdAt: Date.now(),
    });
    await storage.touchRoom(room.id);
  } catch (err) {
    console.error(`[sala ${room.id}] no se pudo persistir el mensaje:`, err);
  }
}

function systemMsg(room: Room, text: string, color = "#a9abd0"): void {
  void say(room, { from: "sistema", color, role: "system", text });
}

/** Cola de mensajes pendientes por agente (para el coalescing del coordinador). */
const pendingByAgent = new Map<string, string[]>();

/**
 * Despacha trabajo a UN agente. El coordinador garantiza un solo drain activo
 * por agentId — pero agentes distintos corren EN PARALELO (esa es la clave).
 * Si el agente ya está corriendo, el mensaje se acumula y se atiende en UNA
 * sola re-ejecución al terminar (coalescing).
 */
async function dispatchAgent(room: Room, agentId: string, userText: string): Promise<void> {
  const key = `${room.id}:${agentId}`;
  const queue = pendingByAgent.get(key) ?? [];
  queue.push(userText);
  pendingByAgent.set(key, queue);

  await room.coordinator.run(key, async (signal) => {
    const pending = pendingByAgent.get(key) ?? [];
    pendingByAgent.set(key, []);
    if (pending.length === 0) return;
    // Coalescing: varios mensajes acumulados se atienden en un solo turno.
    const task = pending.join("\n\n");
    await runAgentTurn(room, agentId, task, signal);
  });
}

/** Un turno completo de un agente: abre turno durable, corre el loop, commitea. */
async function runAgentTurn(
  room: Room,
  agentId: string,
  task: string,
  signal: AbortSignal,
): Promise<void> {
  const agent = room.agents.get(agentId);
  if (!agent) return;

  agent.task = task.slice(0, 80);
  room.agents.setState(agentId, "working");
  io.to(room.id).emit("agents", { agents: room.agents.list() });

  const turn = await startTurn(room.workspace.dir, { roomId: room.id, agentId, task });
  // Si la sala despertó tras un reinicio, el historial vive en la BD.
  let history = room.histories.get(agentId);
  if (!history) {
    history = await (await getStorage()).getAgentHistory(room.id, agentId);
    room.histories.set(agentId, history);
  }

  try {
    const result = await runAgent({
      provider,
      workspaceDir: room.workspace.dir,
      messages: history,
      userMessage: task,
      signal,
      agentId,
      callbacks: {
        onText: (delta) => io.to(room.id).emit("agent:delta", { agentId, text: delta }),
        onToolStart: ({ name, input }) => {
          room.agents.touch(agentId);
          io.to(room.id).emit("agent:tool", {
            agentId,
            name,
            summary: summarizeTool(name, input),
          });
        },
        onToolEvent: (e) => {
          if (e.type === "file:changed") {
            io.to(room.id).emit("file:changed", { path: e.path, action: e.action });
          }
        },
      },
      // Estados visibles: "esperando" NO es alarma, es fila (ver DESIGN.md).
      onWaitStart: (info) => {
        room.agents.startWaiting(agentId, info);
        io.to(room.id).emit("agents", { agents: room.agents.list() });
      },
      onWaitEnd: () => {
        room.agents.endWaiting(agentId);
        io.to(room.id).emit("agents", { agents: room.agents.list() });
      },
    });

    await say(room, {
      from: agent.name,
      color: agent.color,
      role: "agent",
      text: result.finalText,
    });
    room.histories.set(agentId, result.messages);
    // Persistir la conversación del agente para que continúe tras un reinicio.
    void getStorage().then((s) => s.saveAgentHistory(room.id, agentId, result.messages));

    // Canal 2: el turno cierra con UN commit (unidad de sentido del scrubber).
    const hash = await commitTurn(room.workspace.dir, turn, { summary: result.finalText });
    if (hash) io.to(room.id).emit("history:new", { hash, agentId, message: turn.task });
  } catch (err) {
    await failTurn(room.workspace.dir, turn.id);
    systemMsg(room, `${agent.name} falló: ${String(err)}`, "#d95d63");
  } finally {
    room.agents.finish(agentId);
    io.to(room.id).emit("agents", { agents: room.agents.list() });
  }
}

/** Formatea el elemento anclado como texto legible para el prompt del agente. */
function anchorText(el: SelectedElement): string {
  const textPart = el.text ? ` con el texto "${el.text}"` : "";
  return `[El usuario seleccionó este elemento del preview: <${el.tag}>${textPart}, ubicado en "${el.path}". Encuentra el código correspondiente y aplica el cambio que pide abajo a ESE elemento.]`;
}

function summarizeTool(name: string, input: Record<string, unknown>): string {
  if (name === "write_file" || name === "edit_file") return `${name} → ${input.path}`;
  if (name === "read_file") return `leyendo ${input.path}`;
  if (name === "bash") return `$ ${String(input.command).slice(0, 60)}`;
  if (name === "glob" || name === "grep") return `${name} ${input.pattern ?? ""}`;
  return name;
}

/** Espera a que el preview de la sala arranque y avisa a todos su URL. */
async function notifyPreviewWhenReady(room: Room): Promise<void> {
  for (let i = 0; i < 120; i++) {
    if (room.preview) {
      io.to(room.id).emit("preview:ready", { previewUrl: room.preview.url });
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// ── Arranque ────────────────────────────────────────────────────────────────

// Al apagar (Ctrl+C, reinicio de tsx watch), matar los dev servers de las salas
// para no dejar procesos huérfanos ocupando puertos.
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[${signal}] apagando previews de las salas…`);
  await stopAllPreviews();
  await fastify.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await fastify.listen({ port: PORT, host: "0.0.0.0" });
  hookPreviewProxy();
  // Las salas no se despiertan al arrancar: sería carísimo levantar N dev
  // servers. Cada una despierta cuando alguien entra (wakeRoom).
  const salas = await loadRoomIndex();
  console.log(
    `Multi server en http://localhost:${PORT}  (provider: ${provider.name}, ${salas} sala(s) guardada(s))`,
  );
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}

/** Carga simple de server/.env. */
async function loadEnv(): Promise<void> {
  const envPath = join(process.cwd(), ".env");
  if (!existsSync(envPath)) return;
  const text = await readFile(envPath, "utf8");
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
