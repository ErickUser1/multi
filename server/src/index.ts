import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
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
  maybeStartPreview,
  ensureRunner,
  loadRoomIndex,
  type Room,
  type SelectedElement,
} from "./rooms.js";
import { getStorage } from "./storage/index.js";
import { setCredential, getCredential, clearCredential } from "./keys.js";
import { makeProvider, esProviderId, PERFILES } from "./agent/providers/profiles.js";
import { MAX_AGENTS_PER_ROOM, resumenDeOtros } from "./engine/agents.js";
import { fileMutation } from "./engine/file-mutation.js";
import { startTurn, commitTurn, failTurnConCommit } from "./engine/turns.js";
import { commitAll, discardChanges, diffCommit, revertTo, revertFile } from "./engine/git.js";
import { getHistory, setBookmark } from "./engine/history.js";
import { buildApiMap } from "./engine/api-map.js";
import { handlePreviewRequest, handlePreviewUpgrade } from "./engine/proxy.js";
import { isDockerAvailable, ensureImage, sweepOrphanContainers } from "./engine/container.js";
import { runAgent } from "./agent/loop.js";
import type { ModelProvider, Message } from "./agent/providers/types.js";
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

/**
 * ESTE server (Fastify, :4000) sirve también la Sala cuando hay un build.
 *
 * Por qué: para que alguien de fuera entre hace falta UNA sola URL. Hoy son dos
 * puertos (la Sala en :5173, el server en :4000) y eso serían dos túneles —
 * ngrok gratis da uno. Con todo en el mismo origen, además, desaparecen los
 * problemas de CORS y de la cookie del proxy.
 *
 * Cuándo se activa: solo si `web/dist` existe, o sea después de compilar el
 * front. Mientras desarrollas no hay build, esto no corre, y sigues usando Vite
 * en :5173 con su HMR. Es el reparto normal: en dev el front tiene su propio
 * server para el hot reload; al publicar, lo sirve el backend.
 *
 * Va en un contexto propio para poder poner un notFound que devuelva
 * index.html: la Sala enruta en el cliente (#/sala/x), así que una ruta
 * desconocida debe caer en la app, no en un 404 (patrón de @fastify/static).
 */
const WEB_DIST = join(process.cwd(), "..", "web", "dist");
const SIRVE_WEB = existsSync(join(WEB_DIST, "index.html"));

if (SIRVE_WEB) {
  await fastify.register(async (ctx) => {
    await ctx.register(fastifyStatic, { root: WEB_DIST, wildcard: false });
    ctx.setNotFoundHandler((req, reply) => {
      // Las rutas de API que no existen sí son 404: no tiene sentido
      // devolverles el HTML de la app.
      if (req.url.startsWith("/rooms") || req.url.startsWith("/preview")) {
        return reply.code(404).send({ error: "no encontrado" });
      }
      return reply.code(200).type("text/html").sendFile("index.html");
    });
  });
}

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

// El mapa del back: qué endpoints llama el front y cuáles existen de verdad.
fastify.get<{ Params: { id: string } }>("/rooms/:id/api-map", async (req, reply) => {
  const room = getRoom(req.params.id) ?? (await wakeRoom(req.params.id));
  if (!room) return reply.code(404).send({ error: "sala no encontrada" });
  return await buildApiMap(room.workspace.dir);
});

/**
 * Los modelos que ofrece un proveedor, traídos de él mismo.
 *
 * Una lista escrita a mano envejece: OpenRouter tenía 341 modelos el día que se
 * escribió esto y en unos meses serán otros. Los perfiles siguen sirviendo como
 * sugerencia (y para cuando el proveedor no publica catálogo), pero si se puede
 * preguntar, se pregunta.
 */
fastify.get<{ Params: { id: string } }>("/providers/:id/models", async (req, reply) => {
  if (req.params.id !== "openrouter") {
    // Los demás no publican catálogo abierto: se queda con los sugeridos.
    return { models: [] };
  }
  try {
    const r = await fetch("https://openrouter.ai/api/v1/models", {
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return { models: [] };
    const data = (await r.json()) as { data?: Array<{ id: string; context_length?: number }> };
    return {
      models: (data.data ?? []).map((m) => ({
        id: m.id,
        free: m.id.endsWith(":free"),
        context: m.context_length ?? 0,
      })),
    };
  } catch {
    // Sin internet o el proveedor caído: la UI se queda con los sugeridos.
    return reply.send({ models: [] });
  }
});

/**
 * La conversación de un agente. SOLO con MULTI_DEBUG=1.
 *
 * Nada del producto lo consume: existe para diagnosticar y para que los demos
 * puedan comprobar cosas que de otro modo no se ven. Va detrás de una bandera
 * porque expone la conversación completa de un agente — incluido lo que la gente
 * escribió en el chat — y eso no debe estar abierto por default.
 */
if (process.env.MULTI_DEBUG === "1") {
  fastify.get<{ Params: { id: string; agentId: string } }>(
    "/rooms/:id/agents/:agentId/history",
    async (req, reply) => {
      const room = getRoom(req.params.id) ?? (await wakeRoom(req.params.id));
      if (!room) return reply.code(404).send({ error: "sala no encontrada" });
      const enMemoria = room.histories.get(req.params.agentId);
      const messages =
        enMemoria ?? (await (await getStorage()).getAgentHistory(room.id, req.params.agentId));
      return { messages };
    },
  );
}

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
 * MULTI_TEST_MOCK=1 cambia el agente por uno simulado — lo usan SOLO los demos
 * automatizados, para que las verificaciones no gasten API key. El nombre lleva
 * "TEST" a propósito: nadie lo pone por accidente creyendo que es una opción
 * normal, y el arranque lo grita.
 */
const TEST_MOCK = process.env.MULTI_TEST_MOCK === "1";
if (TEST_MOCK) {
  console.warn("\n  *** AGENTE SIMULADO (MULTI_TEST_MOCK=1) — solo para pruebas ***\n");
}

/**
 * Credencial de respaldo. Solo tiene sentido cuando corres Multi para ti (es tu
 * máquina y tu key); en cuanto invitas gente, cada quien trae la suya o te
 * gastan el saldo.
 *
 * `MULTI_PROVIDER` permite que el respaldo no sea Anthropic: quien corra Multi
 * con OpenRouter o con Ollama local no debería tener que tocar código.
 */
const FALLBACK = (() => {
  const id = process.env.MULTI_PROVIDER ?? "anthropic";
  if (!esProviderId(id)) return null;
  const apiKey = process.env.MULTI_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  return { provider: id, apiKey, model: process.env.MULTI_MODEL };
})();

/**
 * El proveedor de modelo de QUIEN pidió el turno.
 *
 * La credencial es de la persona, no del server: cada quien paga lo que pide y
 * con el proveedor que quiera (uno con Claude, otro con un modelo gratis, otro
 * con Ollama en su máquina). Si no tiene y hay respaldo en el `.env`, se usa ese
 * (modo "corro Multi para mí"). Si no hay ninguno, el turno no arranca y se le
 * dice a esa persona.
 */
function providerFor(socketId: string): ModelProvider | null {
  if (TEST_MOCK) return createDevMock();
  const cred = getCredential(socketId) ?? FALLBACK;
  if (!cred) return null;
  try {
    return makeProvider(cred.provider, cred.apiKey, cred.model);
  } catch (err) {
    // Se trata como "sin credencial", pero SE DICE: un catch mudo aquí dejaba al
    // agente colgado sin explicación, y desde la sala parecía que Multi se había
    // quedado pensando.
    console.error(`[provider] no se pudo construir ${cred.provider}:`, err);
    return null;
  }
}

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
      // Quien llega a media cuesta no recibió el "preview:arrancando" (ya pasó),
      // y sin esto vería "la sala está vacía" mientras el proyecto se levanta.
      previewArrancando: room.previewBooting === true,
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

    // El turno corre con la key de QUIEN lo pide: cada quien paga lo suyo.
    const provider = providerFor(socket.id);
    if (!provider) {
      // Solo a esta persona: que le falte key a alguien no es asunto de la sala.
      socket.emit("error:key", {
        message:
          "Para pedirle algo a un agente necesitas tu propia API key de Anthropic. Pégala arriba y vuelve a intentar.",
      });
      return;
    }

    // Anclaje: prependemos el elemento como texto legible (cuidado 3).
    const withAnchor = (t: string) => (anchor ? `${anchorText(anchor)}\n\n${t}` : t);

    if (intent.kind === "address") {
      // "@agente-2 ..." → join a ese agente (coalescing, no arranca otro loop).
      const target = room.agents.findByMention(intent.agentName);
      if (!target) {
        systemMsg(room, `no existe "${intent.agentName}" en esta sala`);
        return;
      }

      // Interrumpir si está trabajando: cualquiera en la sala puede corregir el
      // rumbo sin esperar. Si tu compa le pidió el front rojo y tú ves que va
      // mal, decir "mejor azul" tiene que parar lo que hace AHORA — esperar 30
      // segundos a que termine algo que ya sabes que está mal es tiempo tirado.
      // Lo que alcanzó a escribir se queda en disco (el turno se marca fallido);
      // el mensaje nuevo arranca un turno fresco sobre ese estado.
      if (target.state !== "idle") {
        room.coordinator.interrupt(`${room.id}:${target.id}`);
        // Se dice que va a RETOMAR, no solo que se detuvo: sin eso el chat mostraba
        // "X interrumpió a agente-1" y después, sin aviso, un comando distinto —
        // parecía que el agente se había quedado callado y arrancado por su cuenta.
        systemMsg(
          room,
          `${member.name} redirigió a ${target.name} — retomando con lo nuevo`,
          member.color,
        );
      }

      void dispatchAgent(room, target.id, withAnchor(intent.task), provider);
    } else {
      // "@agente ..." = quiero uno NUEVO, siempre. Es la forma de lanzar trabajo
      // en paralelo, y el menú lo ofrece con esas palabras ("lanzar otro").
      // Reutilizar al que estuviera libre hacía que el botón mintiera: pedías
      // otro agente y te contestaba el mismo.
      //
      // Para seguirle hablando a uno existente se le menciona por su nombre
      // (@agente-1), que el menú lista arriba con lo que hizo.
      //
      // Excepción: un mensaje anclado sin @ no expresa "quiero otro agente" —
      // solo señala un elemento y pide algo. Ahí sí conviene el que ya está.
      const soloAnclado = !text.trim().startsWith("@");
      const libre = soloAnclado
        ? room.agents.list().find((a) => a.state === "idle")
        : undefined;

      if (libre) {
        void dispatchAgent(room, libre.id, withAnchor(intent.task), provider);
      } else {
        const agent = room.agents.spawn(intent.task);
        if (!agent) {
          systemMsg(
            room,
            `ya hay ${MAX_AGENTS_PER_ROOM} agentes trabajando; espera a que alguno termine`,
          );
          return;
        }
        io.to(room.id).emit("agents", { agents: room.agents.list() });
        // Que quede claro que nació uno nuevo, en vez de que aparezca sin más.
        systemMsg(room, `entró ${agent.name} a la sala`, agent.color);
        void dispatchAgent(room, agent.id, withAnchor(intent.task), provider);
      }
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

  /**
   * Guardar la API key de esta persona. Solo en memoria, solo para su socket:
   * no se emite a la sala, no se escribe en disco, no entra al contenedor.
   * La confirmación va únicamente a quien la mandó.
   */
  socket.on("auth:key", (payload: Record<string, unknown>) => {
    const res = setCredential(socket.id, payload);
    if (!res.ok) {
      socket.emit("error:key", { message: res.message });
      return;
    }
    socket.emit("auth:ok");
    // Los demás solo se enteran de QUE puede invocar agentes, nunca de la key.
    if (joinedRoom) {
      const member = joinedRoom.members.get(socket.id);
      if (member) member.canInvoke = true;
      io.to(joinedRoom.id).emit("presence", { members: membersList(joinedRoom) });
    }
  });

  /** Olvidar mi key (prestar la compu, compartir pantalla). */
  socket.on("auth:forget", () => {
    clearCredential(socket.id);
    if (joinedRoom) {
      const member = joinedRoom.members.get(socket.id);
      if (member) member.canInvoke = false;
      io.to(joinedRoom.id).emit("presence", { members: membersList(joinedRoom) });
    }
  });

  socket.on("disconnect", () => {
    clearCredential(socket.id); // la key del server se va con el socket
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
async function dispatchAgent(
  room: Room,
  agentId: string,
  userText: string,
  provider: ModelProvider,
): Promise<void> {
  const key = `${room.id}:${agentId}`;
  const queue = pendingByAgent.get(key) ?? [];
  queue.push(userText);
  pendingByAgent.set(key, queue);

  await room.coordinator.run(key, async (signal) => {
    // Si ya venía abortado, no se toca la cola: lo encolado es para el turno
    // siguiente, no para este que está muriendo.
    if (signal.aborted) return;

    const pending = pendingByAgent.get(key) ?? [];
    pendingByAgent.set(key, []);
    if (pending.length === 0) return;
    // Coalescing: varios mensajes acumulados se atienden en un solo turno.
    const task = pending.join("\n\n");

    try {
      await runAgentTurn(room, agentId, task, signal, provider);
    } catch (err) {
      // Si el turno se cortó, lo que se sacó de la cola NO se ejecutó: se
      // devuelve al frente para que lo atienda el turno siguiente.
      //
      // Sin esto el mensaje se perdía en silencio. Es lo que pasaba al
      // interrumpir y decir "continúa": el turno moribundo vaciaba la cola,
      // se llevaba el "continúa", y el agente respondía como si nadie le
      // hubiera dicho nada.
      const ahora = pendingByAgent.get(key) ?? [];
      pendingByAgent.set(key, [...pending, ...ahora]);
      throw err;
    }
  });
}

/** Un turno completo de un agente: abre turno durable, corre el loop, commitea. */
async function runAgentTurn(
  room: Room,
  agentId: string,
  task: string,
  signal: AbortSignal,
  provider: ModelProvider,
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

  /**
   * El historial tal como va, espejado desde el loop.
   *
   * Si el turno LANZA, el array del loop se va con el stack (es una copia local).
   * Sin esto el turno entero se perdia: el agente arrancaba de cero, releia el
   * proyecto y podia reescribir lo que ya habia hecho.
   */
  let historialVivo: Message[] | null = null;

  try {
    const result = await runAgent({
      provider,
      workspaceDir: room.workspace.dir,
      onProgreso: (msgs) => {
        historialVivo = msgs;
      },
      // Los comandos del agente corren en el contenedor de la sala (o local si
      // no hay Docker). El agente no distingue: es la misma tool.
      runner: await ensureRunner(room),
      messages: history,
      // Qué están haciendo los demás, para que no repita su trabajo. Se calcula
      // AL EMPEZAR el turno: es una foto del momento, no una suscripción.
      userMessage: conContextoDeOtros(room, agentId, task),
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

    // El historial se guarda SIEMPRE, también si lo interrumpieron: es lo que
    // permite que el mensaje siguiente continúe con lo que ya se había hecho.
    room.histories.set(agentId, result.messages);
    void getStorage().then((s) => s.saveAgentHistory(room.id, agentId, result.messages));

    if (result.interrumpido) {
      // Sin mensaje del agente: quien interrumpió ya está escribiendo lo suyo, y
      // un "me interrumpieron" en el chat solo estorba. Lo escrito se conserva.
      await commitTurn(room.workspace.dir, turn, { summary: "(interrumpido)" });
      return;
    }

    await say(room, {
      from: agent.name,
      color: agent.color,
      role: "agent",
      text: result.finalText,
    });

    // Canal 2: el turno cierra con UN commit (unidad de sentido del scrubber).
    const hash = await commitTurn(room.workspace.dir, turn, { summary: result.finalText });
    if (hash) io.to(room.id).emit("history:new", { hash, agentId, message: turn.task });

    // El turno pudo haber creado el proyecto (la sala nace vacía): si ya se
    // puede levantar, el preview arranca solo y todos lo ven aparecer.
    void notifyPreviewWhenReady(room);
  } catch (err) {
    // El turno falló, pero lo que alcanzó a hacer NO se tira.
    //
    // Un stream que se corta a media generación deja archivos completos en disco
    // (la escritura es atómica) y vueltas completas en el historial (el push del
    // mensaje del assistant ocurre DESPUÉS del catch del loop, así que cada
    // tool_use quedó emparejado con su tool_result). Sin esto, el agente volvía a
    // empezar de cero: releía el proyecto entero y reescribía lo mismo.
    const rescatado = historialVivo as Message[] | null;
    const hayAlgoNuevo = rescatado !== null && rescatado.length > history.length;

    if (hayAlgoNuevo) {
      room.histories.set(agentId, rescatado!);
      void getStorage().then((s) => s.saveAgentHistory(room.id, agentId, rescatado!));
    }

    // Se commitea igual, para que el trabajo aparezca en la línea de tiempo y se
    // pueda volver a él. El turno sigue marcado como fallido: `state` dice cómo
    // terminó, `commit` dice dónde quedó lo hecho.
    const hash = await failTurnConCommit(room.workspace.dir, turn, {
      summary: `${turn.task.slice(0, 60)} (se cortó)`,
    });
    if (hash) io.to(room.id).emit("history:new", { hash, agentId, message: turn.task });

    // El error crudo del proveedor no le sirve a nadie en la sala: se traduce a
    // qué pasó y qué hacer. El detalle técnico va al log del server.
    console.error(`[sala ${room.id}] turno de ${agent.name} falló:`, err);
    systemMsg(room, `${agent.name}: ${explicarFalla(err)}`, "#d95d63");
  } finally {
    room.agents.finish(agentId);
    io.to(room.id).emit("agents", { agents: room.agents.list() });
  }
}

/**
 * Antepone al mensaje un resumen de qué hacen los otros agentes.
 *
 * Va en el mensaje del turno y no en el prompt del sistema porque cambia con
 * cada turno: el prompt del sistema se cachea del lado del proveedor y meterle
 * algo variable tiraría ese caché en cada llamada.
 */
function conContextoDeOtros(room: Room, agentId: string, task: string): string {
  const archivos = fileMutation.trabajoRecienteDeOtros(agentId);
  const resumen = resumenDeOtros(room.agents, agentId, archivos, ultimosMensajes(room));
  return resumen ? `${resumen}\n\n${task}` : task;
}

/**
 * Lo último que dijo cada agente, sacado de su propio historial.
 *
 * No se guarda aparte: es el mismo texto que la sala vio en el chat, y ya vive
 * en `room.histories`. Contarlo otra vez sería duplicar estado.
 */
function ultimosMensajes(room: Room): Map<string, string> {
  const out = new Map<string, string>();
  for (const [agentId, mensajes] of room.histories) {
    // El último mensaje del assistant con texto: lo que reportó al terminar.
    for (let i = mensajes.length - 1; i >= 0; i--) {
      const m = mensajes[i];
      if (m.role !== "assistant") continue;
      const texto = m.content
        .filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
        .map((c) => c.text)
        .join(" ")
        .trim();
      if (texto) {
        out.set(agentId, texto);
        break;
      }
    }
  }
  return out;
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

/**
 * Intenta arrancar el preview y, si arrancó, avisa a todos.
 *
 * Se llama cuando pudo aparecer un proyecto: al entrar a la sala (por si ya
 * había uno) y al cerrar cada turno de agente (por si lo acaba de scaffoldear).
 * Que no arranque NO es error: la sala vacía es el estado normal al empezar.
 */
async function notifyPreviewWhenReady(room: Room): Promise<void> {
  const url = await maybeStartPreview(room, (etapa) => {
    // Por dónde va el arranque. Sin esto la sala muestra "está vacía" mientras
    // el proyecto SÍ existe y se está levantando, que es mentira y se siente
    // como una pantalla muerta.
    io.to(room.id).emit("preview:arrancando", { etapa });
  });
  if (url) {
    io.to(room.id).emit("preview:ready", { previewUrl: url });
    return;
  }

  // Sin URL: o la sala sigue vacía (normal, no hay nada que levantar) o el
  // arranque falló. En ambos casos hay que avisar, porque quien vio una etapa se
  // quedaría con el spinner girando para siempre esperando un ready que no llega.
  io.to(room.id).emit("preview:sin-arranque");
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

/**
 * Prepara el aislamiento. Con Docker: barre contenedores de una corrida anterior
 * y construye la imagen si falta. Sin Docker: lo avisa fuerte.
 *
 * No degradar en silencio: correr sin aislamiento es una decisión que el dueño
 * de la máquina debe estar tomando a sabiendas, no descubrir después.
 */
async function setupIsolation(): Promise<void> {
  if (!(await isDockerAvailable())) {
    console.warn(
      [
        "",
        "  *** SIN AISLAMIENTO: no hay Docker disponible ***",
        "  Los comandos del agente corren en ESTA máquina, no en un contenedor.",
        "  Para ti solo puede estar bien; si vas a invitar a alguien a una sala,",
        "  esa persona le estará dando órdenes a un agente con acceso a tu equipo.",
        "",
      ].join("\n"),
    );
    return;
  }

  const barridos = await sweepOrphanContainers();
  if (barridos > 0) console.log(`[docker] ${barridos} contenedor(es) de una corrida anterior, borrados`);

  await ensureImage(join(process.cwd(), ".."));
}

try {
  await setupIsolation();
  await fastify.listen({ port: PORT, host: "0.0.0.0" });
  hookPreviewProxy();
  // Las salas no se despiertan al arrancar: sería carísimo levantar N dev
  // servers. Cada una despierta cuando alguien entra (wakeRoom).
  const salas = await loadRoomIndex();
  const modoKeys = TEST_MOCK
    ? "agente simulado"
    : FALLBACK
      ? `respaldo: ${PERFILES[FALLBACK.provider].label} + key propia por persona`
      : "cada quien trae su key";
  console.log(
    `Multi server en http://localhost:${PORT}  (${modoKeys}, ${salas} sala(s) guardada(s))`,
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

/**
 * Traduce el error de un turno a algo accionable para quien está en la sala.
 *
 * Los errores de los proveedores llegan crudos ("ProviderError: OpenRouter:
 * Internal Server Error", o un JSON de 400 completo). Eso no le dice a nadie si
 * el problema es su cuenta, su key, o que el servicio se cayó — y sin saberlo no
 * puede hacer nada.
 */
function explicarFalla(err: unknown): string {
  const texto = String(err);

  // Antes que el de créditos: este mensaje TAMBIÉN habla de saldo, y si cae en
  // el genérico se le dice "recarga" a alguien que sí tiene dinero.
  if (texto.includes("el techo de salida no cabe")) {
    return "tu saldo no alcanza para el tamaño de respuesta que se pidió. Se reintentó con uno más chico y tampoco cupo: recarga saldo o usa un modelo más barato.";
  }
  if (texto.includes("credit balance") || texto.includes("insufficient")) {
    return "se acabaron los créditos de tu cuenta. Pon otra key o recarga saldo.";
  }
  if (texto.includes("401") || texto.includes("key inválida") || texto.includes("invalid_api_key")) {
    return "tu API key no es válida. Revísala en el panel de arriba.";
  }
  if (texto.includes("rate") || texto.includes("429")) {
    return "tu cuenta llegó a su límite de uso por ahora. Espera un momento o usa otra key.";
  }
  if (texto.includes("Internal Server Error") || texto.includes("no responde") || texto.includes("503")) {
    return "el proveedor del modelo está fallando (no es cosa tuya). Vuelve a intentar, o cambia de modelo en el panel.";
  }
  if (texto.includes("model") && texto.includes("not found")) {
    return "ese modelo no existe o tu cuenta no tiene acceso. Elige otro en el panel.";
  }
  if (texto.includes("se cortó a media escritura")) {
    return "la respuesta del modelo se cortó a la mitad. Suele ser falta de créditos o una caída de conexión, vuelve a intentar.";
  }
  if (texto.includes("AbortError")) {
    return "el turno se detuvo.";
  }

  // Sin patrón conocido: se muestra recortado, no el volcado entero.
  return `algo falló — ${texto.slice(0, 120)}`;
}
