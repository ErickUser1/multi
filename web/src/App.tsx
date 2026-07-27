import { useEffect, useRef, useState, useCallback } from "react";
import type { Socket } from "socket.io-client";
import {
  connectSocket,
  createRoom,
  SERVER_URL,
  type ChatMessage,
  type Member,
  type JoinedPayload,
  type SelectedElement,
  type CursorInfo,
  type SelectionInfo,
  type Agent,
  type OrphanTurn,
} from "./socket.js";
import { AgentList } from "./AgentList.js";
import { MentionMenu } from "./MentionMenu.js";
import { Historial } from "./Historial.js";
import { BackCanvas, type Endpoint } from "./BackCanvas.js";

// El roomId vive en el hash de la URL: #/sala/taco-fiesta-42
function readRoomFromHash(): string | null {
  const m = window.location.hash.match(/#\/sala\/([\w-]+)/);
  return m ? m[1] : null;
}

export function App() {
  const [roomId, setRoomId] = useState<string | null>(readRoomFromHash());
  const [name, setName] = useState<string>(localStorage.getItem("multi-name") ?? "");
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    const onHash = () => setRoomId(readRoomFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Pantalla 1: sin sala → crear o pegar link.
  if (!roomId) return <Landing />;

  // Pantalla 2: hay sala pero falta nombre.
  if (!entered) {
    return (
      <NamePrompt
        roomId={roomId}
        name={name}
        setName={setName}
        onEnter={() => {
          localStorage.setItem("multi-name", name || "anónimo");
          setEntered(true);
        }}
      />
    );
  }

  // Pantalla 3: la sala.
  return <Sala roomId={roomId} name={name || "anónimo"} />;
}

// ── Pantalla: crear / entrar a sala ────────────────────────────────────────

function Landing() {
  const [busy, setBusy] = useState(false);

  const nueva = async () => {
    setBusy(true);
    try {
      const id = await createRoom();
      window.location.hash = `#/sala/${id}`;
    } catch (e) {
      alert("no se pudo crear la sala: " + String(e));
      setBusy(false);
    }
  };

  return (
    <div className="center-screen">
      <div className="card">
        <h1 className="brand">MULTI</h1>
        <p className="sub">un lugar para vibecodear con tus compas</p>
        <button className="cta" onClick={nueva} disabled={busy}>
          {busy ? "creando sala…" : "Crear una sala"}
        </button>
        <p className="hint">o pega el link que te pasó tu compa</p>
      </div>
    </div>
  );
}

// ── Pantalla: pedir nombre ─────────────────────────────────────────────────

function NamePrompt(props: {
  roomId: string;
  name: string;
  setName: (n: string) => void;
  onEnter: () => void;
}) {
  return (
    <div className="center-screen">
      <div className="card">
        <p className="sub">vas a entrar a la sala</p>
        <h2 className="room-name">{props.roomId}</h2>
        <input
          className="name-input"
          placeholder="¿cómo te llamas?"
          value={props.name}
          onChange={(e) => props.setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && props.onEnter()}
          autoFocus
        />
        <button className="cta" onClick={props.onEnter}>
          Entrar
        </button>
      </div>
    </div>
  );
}

// ── La Sala ─────────────────────────────────────────────────────────────────

function Sala({ roomId, name }: { roomId: string; name: string }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [previewReady, setPreviewReady] = useState(false);
  const [draft, setDraft] = useState("");

  const socketRef = useRef<Socket | null>(null);
  // Streaming POR AGENTE: varios pueden estar hablando a la vez.
  const [streaming, setStreaming] = useState<Record<string, string>>({});
  const [toolLines, setToolLines] = useState<Record<string, string>>({});
  const [agents, setAgents] = useState<Agent[]>([]);
  const [orphans, setOrphans] = useState<OrphanTurn[]>([]);
  /** Query del menú de menciones (null = cerrado). */
  const [mention, setMention] = useState<string | null>(null);
  /** Se incrementa cuando el historial cambia, para que el scrubber recargue. */
  const [histVersion, setHistVersion] = useState(0);
  /** Se incrementa cuando cambia un archivo, para que el mapa del back recargue. */
  const [apiVersion, setApiVersion] = useState(0);
  /** Qué tab del escenario se ve. */
  const [tab, setTab] = useState<"app" | "back">("app");

  // Modo inspect activo (para seleccionar elementos del preview).
  const [inspect, setInspect] = useState(false);
  // MI selección local (la que se ancla al mandar mensaje) — cuidado 2.
  const [mySelection, setMySelection] = useState<SelectedElement | null>(null);
  // Cursores de OTROS (socketId → info).
  const [cursors, setCursors] = useState<Record<string, CursorInfo>>({});
  // Selecciones de OTROS (socketId → info), para dibujar sus outlines.
  const [selections, setSelections] = useState<Record<string, SelectionInfo>>({});

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const escenarioRef = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // El iframe apunta al PROXY del server (que inyecta el inspector), no al dev server directo.
  const previewSrc = `${SERVER_URL}/preview/${roomId}`;
  // Origen del proxy, para validar postMessage — cuidado 1.
  const proxyOrigin = new URL(SERVER_URL).origin;

  useEffect(() => {
    const socket = connectSocket();
    socketRef.current = socket;

    socket.on("connect", () => socket.emit("join", { roomId, name }));

    socket.on("joined", (p: JoinedPayload) => {
      setMembers(p.members);
      if (p.previewUrl) setPreviewReady(true);
      if (p.agents) setAgents(p.agents);
      if (p.orphanTurns?.length) setOrphans(p.orphanTurns);
      // El chat que ya existía en la sala (sobrevivió al reinicio).
      if (p.messages?.length) setMessages(p.messages);
    });
    socket.on("presence", ({ members }: { members: Member[] }) => setMembers(members));
    socket.on("preview:ready", () => setPreviewReady(true));
    socket.on("agents", ({ agents }: { agents: Agent[] }) => setAgents(agents));
    // Hay un punto nuevo en la línea de tiempo (commit, revert o bookmark).
    socket.on("history:new", () => setHistVersion((v) => v + 1));
    socket.on("history:changed", () => setHistVersion((v) => v + 1));
    socket.on("orphans", ({ turns }: { turns: OrphanTurn[] }) => setOrphans(turns));
    // Un archivo cambió: el contrato front/back pudo haberse movido. El mismo
    // canal de tiempo real que alimenta el preview alimenta el semáforo.
    socket.on("file:changed", () => setApiVersion((v) => v + 1));

    socket.on("chat:message", (m: ChatMessage) => {
      setMessages((prev) => [...prev, m]);
      // Al llegar el mensaje final de UN agente, limpiar SU streaming (no el de otros).
      if (m.role === "agent") {
        setStreaming((prev) => {
          const n = { ...prev };
          delete n[m.from];
          return n;
        });
        setToolLines((prev) => {
          const n = { ...prev };
          delete n[m.from];
          return n;
        });
      }
    });
    // Cada delta trae el agentId: se acumula en el mensaje de ESE agente.
    socket.on("agent:delta", ({ agentId, text }: { agentId: string; text: string }) =>
      setStreaming((p) => ({ ...p, [agentId]: (p[agentId] ?? "") + text })),
    );
    socket.on("agent:tool", ({ agentId, summary }: { agentId: string; summary: string }) =>
      setToolLines((p) => ({ ...p, [agentId]: summary })),
    );

    // Cursores de otros.
    socket.on("cursor", (c: CursorInfo) => {
      setCursors((prev) => ({ ...prev, [c.socketId]: c }));
    });
    socket.on("cursor:gone", ({ socketId }: { socketId: string }) => {
      setCursors((prev) => {
        const n = { ...prev };
        delete n[socketId];
        return n;
      });
    });
    // Selecciones de otros (broadcast).
    socket.on("select", (s: SelectionInfo) => {
      setSelections((prev) => {
        const n = { ...prev };
        if (s.element) n[s.socketId] = s;
        else delete n[s.socketId];
        return n;
      });
    });

    socket.on("error:join", ({ message }: { message: string }) => alert(message));

    return () => {
      socket.disconnect();
    };
  }, [roomId, name]);

  // Escuchar mensajes del inspector (dentro del iframe) — con validación de origen.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== proxyOrigin) return; // cuidado 1
      const m = e.data;
      if (!m || m.source !== "multi-inspector") return;
      if (m.type === "element:selected") {
        const el = m.data as SelectedElement;
        setMySelection(el);
        socketRef.current?.emit("select", el);
      } else if (m.type === "element:gone") {
        // El elemento que tenía seleccionado desapareció (HMR) — cuidado edge case.
        setMySelection(null);
        socketRef.current?.emit("select", null);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [proxyOrigin]);

  // Enviar al inspector (dentro del iframe) el estado de inspect / clear.
  const postToInspector = useCallback((msg: object) => {
    iframeRef.current?.contentWindow?.postMessage({ source: "multi-parent", ...msg }, proxyOrigin);
  }, [proxyOrigin]);

  useEffect(() => {
    postToInspector({ type: "inspect:set", value: inspect });
  }, [inspect, postToInspector]);

  // Broadcast de mi cursor sobre el escenario (throttled ~40ms).
  useEffect(() => {
    const el = escenarioRef.current;
    if (!el) return;
    let last = 0;
    const onMove = (e: MouseEvent) => {
      const now = Date.now();
      if (now - last < 40) return;
      last = now;
      const r = el.getBoundingClientRect();
      socketRef.current?.emit("cursor", { x: e.clientX - r.left, y: e.clientY - r.top });
    };
    el.addEventListener("mousemove", onMove);
    return () => el.removeEventListener("mousemove", onMove);
  }, [previewReady]);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    // Anclar MI selección local al mensaje (cuidado 2/3/4).
    socketRef.current?.emit("chat", { text, anchor: mySelection });
    setDraft("");
    setMention(null);
    if (mySelection) {
      setMySelection(null);
      postToInspector({ type: "selection:clear" }); // cuidado 4
      setInspect(false);
    }
  };

  /**
   * Anclar un endpoint al chat. A diferencia del anclaje del preview (que manda
   * un SelectedElement del DOM), aquí se redacta el pedido en el borrador: el
   * usuario lo lee, lo edita si quiere, y decide cuándo mandarlo.
   */
  const anclarEndpoint = (e: Endpoint) => {
    const donde = e.calls[0] ? ` (el front lo llama desde ${e.calls[0].file})` : "";
    const texto =
      e.status === "faltante"
        ? `@agente crea el endpoint ${e.method} ${e.path}${donde}`
        : `@agente sobre el endpoint ${e.method} ${e.path}: `;
    setDraft(texto);
    setTab("app");
    inputRef.current?.focus();
  };

  // Menú de menciones: se abre al escribir "@" al inicio de una palabra.
  const onDraftChange = (value: string) => {
    setDraft(value);
    const m = value.match(/(?:^|\s)@([a-z0-9-]*)$/i);
    setMention(m ? m[1] : null);
  };

  const pickMention = (name: string) => {
    setDraft((d) => d.replace(/(?:^|\s)@([a-z0-9-]*)$/i, (full) => `${full.startsWith(" ") ? " " : ""}@${name} `));
    setMention(null);
  };

  /** El humano decide qué hacer con el trabajo que quedó a medias por un crash. */
  const resolveOrphans = (action: "keep" | "revert") => {
    socketRef.current?.emit("orphans:resolve", { action });
    setOrphans([]);
  };

  const copyLink = () => navigator.clipboard.writeText(window.location.href);

  return (
    <div className="sala">
      {/* Chat izquierda */}
      <aside className="chat">
        <div className="sala-cab">
          <div className="sala-nombre">{roomId}</div>
          <div className="sala-meta">{members.length} en la sala</div>
        </div>

        {/* Los agentes de la sala, como jugadores visibles */}
        <AgentList agents={agents} />

        {/* Trabajo que quedó a medias por un crash: decide el humano */}
        {orphans.length > 0 && (
          <div className="orphan-card">
            <div className="orphan-text">
              {orphans.length === 1 ? "Un agente se interrumpió" : `${orphans.length} agentes se interrumpieron`} a
              media tarea. ¿Guardas lo que alcanzó a hacer?
            </div>
            <div className="orphan-actions">
              <button className="orphan-btn keep" onClick={() => resolveOrphans("keep")}>
                Guardar
              </button>
              <button className="orphan-btn" onClick={() => resolveOrphans("revert")}>
                Volver al último punto
              </button>
            </div>
          </div>
        )}

        <div className="chat-scroll">
          {messages.map((m, i) => (
            <ChatRow key={i} msg={m} />
          ))}
          {/* Un bloque de streaming POR AGENTE: varios pueden hablar a la vez */}
          {Object.keys({ ...streaming, ...toolLines }).map((agentId) => {
            const agent = agents.find((a) => a.id === agentId);
            const color = agent?.color ?? "#ffc37a";
            return (
              <div className="msg" key={agentId}>
                <div className="av" style={{ background: color, color: "#3d2a12" }}>
                  AI
                </div>
                <div className="msg-cuerpo">
                  <div className="msg-cab">
                    <span className="quien" style={{ color }}>
                      {agent?.name ?? agentId}
                    </span>
                  </div>
                  {toolLines[agentId] && <div className="tool-line">{toolLines[agentId]}</div>}
                  {streaming[agentId] && <div className="burbuja">{streaming[agentId]}</div>}
                </div>
              </div>
            );
          })}
        </div>

        <div className="chat-input">
          {mySelection && (
            <div className="anchor-chip">
              anclado a &lt;{mySelection.tag}&gt;{mySelection.text ? ` "${mySelection.text.slice(0, 24)}"` : ""}
              <span className="anchor-x" onClick={() => { setMySelection(null); postToInspector({ type: "selection:clear" }); }}>
                ×
              </span>
            </div>
          )}
          <div className="input-wrap">
            {mention !== null && (
              <MentionMenu agents={agents} query={mention} onPick={pickMention} />
            )}
            <input
              ref={inputRef}
              className="caja"
              placeholder="habla con la sala — o escribe @agente para pedir algo"
              value={draft}
              onChange={(e) => onDraftChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") send();
                if (e.key === "Escape") setMention(null);
              }}
            />
          </div>
        </div>
      </aside>

      {/* Escenario derecha */}
      <section className="escenario" ref={escenarioRef}>
        <div className="barra-sup">
          <button
            className={`inspect-btn ${inspect ? "on" : ""}`}
            onClick={() => setInspect((v) => !v)}
            title="selecciona un elemento del preview"
          >
            {inspect ? "seleccionando…" : "Seleccionar elemento"}
          </button>
          <div className="presencia">
            {members.map((m) => (
              <div key={m.socketId} className="av" style={{ background: m.color }} title={m.name}>
                {m.name.slice(0, 1).toUpperCase()}
              </div>
            ))}
            <button className="invitar" onClick={copyLink}>
              Copiar link
            </button>
          </div>
        </div>

        <div className="tabs">
          <button className={`tab ${tab === "app" ? "activa" : ""}`} onClick={() => setTab("app")}>
            La app
          </button>
          <button className={`tab ${tab === "back" ? "activa" : ""}`} onClick={() => setTab("back")}>
            El back
          </button>
        </div>

        {tab === "back" && (
          <div className="lienzo">
            <BackCanvas roomId={roomId} version={apiVersion} onAnclar={anclarEndpoint} />
          </div>
        )}

        <div className="lienzo" style={tab === "back" ? { display: "none" } : undefined}>
          {previewReady ? (
            <>
              <iframe
                ref={iframeRef}
                className="preview-frame"
                src={previewSrc}
                title="preview de la app"
              />
              {/* Selecciones de OTROS (con su color/nombre). Nota: se dibujan
                  como badges de aviso; el outline exacto vive dentro del iframe. */}
              <div className="others-selections">
                {Object.values(selections).map((s) => (
                  <div key={s.socketId} className="sel-badge" style={{ borderColor: s.color, color: s.color }}>
                    {s.name} seleccionó &lt;{s.element?.tag}&gt;
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="preview-loading">
              <p>La sala está vacía.</p>
              <p className="preview-loading-sub">
                Pídele a un agente que arranque el proyecto — el stack lo eliges tú.
                <br />
                Por ejemplo: <code>@agente crea un Next con Tailwind</code>
              </p>
            </div>
          )}

          {/* Cursores de otros sobre el escenario */}
          {Object.values(cursors).map((c) => (
            <div key={c.socketId} className="remote-cursor" style={{ left: c.x, top: c.y }}>
              <svg width="16" height="16" viewBox="0 0 16 16">
                <path d="M1 1 L1 12 L4 9 L6 13 L8 12 L6 8 L10 8 Z" fill={c.color} />
              </svg>
              <span className="cursor-name" style={{ background: c.color }}>
                {c.name}
              </span>
            </div>
          ))}
        </div>

        {/* La línea de tiempo de la sala */}
        <Historial
          roomId={roomId}
          version={histVersion}
          onRevert={(hash, file) => socketRef.current?.emit("history:revert", { hash, file })}
          onBookmark={(hash, label) => socketRef.current?.emit("history:bookmark", { hash, label })}
        />
      </section>
    </div>
  );
}

function ChatRow({ msg }: { msg: ChatMessage }) {
  const initial = msg.from.slice(0, msg.role === "agent" ? 2 : 1).toUpperCase();
  return (
    <div className={`msg ${msg.role === "system" ? "msg-system" : ""}`}>
      {msg.role !== "system" && (
        <div className="av" style={{ background: msg.color, color: msg.role === "agent" ? "#3d2a12" : "#fff" }}>
          {msg.role === "agent" ? "AI" : initial}
        </div>
      )}
      <div className="msg-cuerpo">
        {msg.role !== "system" && (
          <div className="msg-cab">
            <span className="quien" style={{ color: msg.color }}>
              {msg.from}
            </span>
          </div>
        )}
        {msg.anchoredTo && <div className="anchor-note">sobre: {msg.anchoredTo}</div>}
        <div className={msg.role === "system" ? "system-text" : "burbuja"}>{msg.text}</div>
      </div>
    </div>
  );
}
