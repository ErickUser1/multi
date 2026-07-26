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
  type Room,
  type SelectedElement,
} from "./rooms.js";
import { handlePreviewRequest, handlePreviewUpgrade } from "./engine/proxy.js";
import { runAgent } from "./agent/loop.js";
import { AnthropicProvider } from "./agent/providers/anthropic.js";
import { MockProvider } from "./agent/providers/mock.js";
import type { ModelProvider } from "./agent/providers/types.js";

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
    if (req.url?.startsWith("/preview/")) return void handlePreviewRequest(req, res);
    for (const l of origRequest) l(req, res);
  });

  const origUpgrade = rawServer.listeners("upgrade") as Array<
    (req: import("node:http").IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => void
  >;
  rawServer.removeAllListeners("upgrade");
  rawServer.on("upgrade", (req, socket, head) => {
    if (req.url?.startsWith("/preview/")) return void handlePreviewUpgrade(req, socket, head);
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

function makeProvider(): ModelProvider {
  const key = process.env.ANTHROPIC_API_KEY;
  if (key) return new AnthropicProvider(key);
  // Sin key: mock que edita App.jsx para demostrar el flujo.
  console.warn("[aviso] sin ANTHROPIC_API_KEY — usando provider MOCK");
  return new MockProvider().scenario({
    match: () => true,
    reply: () => [
      { type: "text", text: "Voy a tocar el App.jsx…" },
      {
        type: "tool_use",
        id: "",
        name: "edit_file",
        input: {
          path: "src/App.jsx",
          old_string: "El motor funciona. Este preview se actualiza solo.",
          new_string: "Cambiado desde la sala.",
        },
      },
    ],
  });
}
const provider = makeProvider();

// ── Socket.IO ─────────────────────────────────────────────────────────────

io.on("connection", (socket) => {
  let joinedRoom: Room | null = null;

  socket.on("join", async ({ roomId, name }: { roomId: string; name: string }) => {
    const room = getRoom(roomId);
    if (!room) {
      socket.emit("error:join", { message: "sala no encontrada" });
      return;
    }
    joinedRoom = room;
    socket.join(roomId);
    const member = addMember(room, socket.id, name || "anónimo");

    // Estado inicial para el que entra.
    socket.emit("joined", {
      roomId,
      you: member,
      members: membersList(room),
      previewUrl: room.preview?.url ?? null,
      history: room.history,
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
    io.to(room.id).emit("chat:message", {
      from: member.name,
      color: member.color,
      role: "human",
      text,
      anchoredTo: anchor ? anchor.path : undefined,
    });

    // 2) Disparar el agente (si no está ocupado).
    if (room.agentBusy) {
      io.to(room.id).emit("chat:message", {
        from: "sistema",
        color: "#a9abd0",
        role: "system",
        text: "el agente está ocupado, espera a que termine…",
      });
      return;
    }
    // Anclaje: prependemos el elemento como texto legible (cuidado 3).
    const prompt = anchor ? `${anchorText(anchor)}\n\n${text}` : text;
    void runAgentInRoom(room, prompt);
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

  socket.on("disconnect", () => {
    if (joinedRoom) {
      removeMember(joinedRoom, socket.id);
      joinedRoom.selections.delete(socket.id);
      socket.to(joinedRoom.id).emit("presence", { members: membersList(joinedRoom) });
      socket.to(joinedRoom.id).emit("cursor:gone", { socketId: socket.id });
    }
  });
});

/** Corre el agente en la sala, streameando todo por socket. */
async function runAgentInRoom(room: Room, userText: string): Promise<void> {
  room.agentBusy = true;
  io.to(room.id).emit("agent:state", { busy: true });

  let streamingText = "";
  const AGENT = { from: "Agente", color: "#ffc37a", role: "agent" as const };

  try {
    const result = await runAgent({
      provider,
      workspaceDir: room.workspace.dir,
      messages: room.history,
      userMessage: userText,
      callbacks: {
        onText: (delta) => {
          streamingText += delta;
          io.to(room.id).emit("agent:delta", { text: delta });
        },
        onToolStart: ({ name, input }) => {
          io.to(room.id).emit("agent:tool", {
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
    });

    // Mensaje final del agente al chat.
    io.to(room.id).emit("chat:message", { ...AGENT, text: result.finalText });
    // Guardar el historial actualizado para continuar la conversación.
    room.history = result.messages;
  } catch (err) {
    io.to(room.id).emit("chat:message", {
      from: "sistema",
      color: "#d95d63",
      role: "system",
      text: `el agente falló: ${String(err)}`,
    });
  } finally {
    room.agentBusy = false;
    io.to(room.id).emit("agent:state", { busy: false });
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
  console.log(`Multi server en http://localhost:${PORT}  (provider: ${provider.name})`);
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
