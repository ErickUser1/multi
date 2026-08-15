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
import { KeyPanel, loadStoredCredencial, type Credencial } from "./KeyPanel.js";
import { EnvPanel } from "./EnvPanel.js";
import { useTextos } from "./i18n.js";
import { MenuSalas } from "./MenuSalas.js";
import { recordarSala, olvidarSala, recordarNombre } from "./historial-salas.js";
import {
  prepararImagen,
  imagenesDe,
  esImagenAceptada,
  ACEPTADOS,
  type AdjuntoPendiente,
} from "./imagenes.js";

/** Cuántas imágenes caben en un mensaje. El server aplica el mismo tope. */
const MAX_ADJUNTOS = 4;

// El roomId vive en el hash de la URL: #/sala/taco-fiesta-42
function readRoomFromHash(): string | null {
  const m = window.location.hash.match(/#\/sala\/([\w-]+)/);
  return m ? m[1] : null;
}

export function App() {
  const [roomId, setRoomId] = useState<string | null>(readRoomFromHash());
  const [name, setName] = useState<string>(localStorage.getItem("multi-name") ?? "");
  /**
   * Si ya diste tu nombre alguna vez, no se te vuelve a preguntar.
   *
   * `entered` es estado de React y se pierde al recargar, así que arrancar
   * siempre en `false` mandaba a la pantalla del nombre CADA vez que alguien
   * refrescaba: con el nombre ya escrito y la sala ya elegida, un botón de
   * "entrar" que solo estorba. Recargar es lo primero que hace la gente cuando
   * algo se ve raro, así que se topaban con eso seguido.
   *
   * El nombre guardado es justo la señal de que esa pantalla ya cumplió su
   * función. Sin nombre sí se pregunta: es la primera vez.
   */
  const [entered, setEntered] = useState(() => !!localStorage.getItem("multi-name"));

  useEffect(() => {
    const onHash = () => setRoomId(readRoomFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  /**
   * Anotar la sala en la que de verdad estás, también al recargar.
   *
   * `recordarSala` vivía solo en el botón de entrar. Con el salto de arriba ese
   * botón deja de pulsarse en la mayoría de las visitas, y sin esto la lista de
   * "tus salas" se quedaría congelada en la primera vez que entraste a cada una.
   *
   * Sigue sin anotarse por el solo hecho de leer el hash: esto corre cuando
   * `entered` ya es cierto, o sea cuando estás dentro, no cuando abriste un link
   * que no llegaste a usar.
   */
  useEffect(() => {
    if (roomId && entered) recordarSala(roomId);
  }, [roomId, entered]);

  /**
   * Sin sala en la URL se entra igual, a la Sala vacía.
   *
   * Antes había una portada con un botón de "crear una sala", y eso hacía dos
   * cosas malas: quien ya tenía salas no las veía (viven en el menú, que solo
   * existe dentro), así que creaba otra; y el único camino para llegar a
   * cualquier lado era crear una, aunque solo quisieras volver a la de ayer.
   * Cuatro de nueve salas acabaron vacías.
   *
   * Ahora se cae dentro con el menú a mano, y crear es un botón más.
   */
  if (!roomId) return <Sala key="sin-sala" roomId={null} name={name || "anónimo"} />;

  // Hay sala pero falta decir cómo te llamas. Sigue haciendo falta para quien
  // llega por un link que le pasaron: la sala necesita saber quién entró.
  if (!entered) {
    return (
      <NamePrompt
        roomId={roomId}
        name={name}
        setName={setName}
        onEnter={() => {
          localStorage.setItem("multi-name", name || "anónimo");
          // La sala se anota en el efecto de arriba, en cuanto `entered` es
          // cierto. Aquí solo se guarda el nombre y se entra.
          setEntered(true);
        }}
      />
    );
  }

  /**
   * Pantalla 3: la sala.
   *
   * La `key` es lo que hace que al cambiar de sala se empiece de cero. Sin
   * ella React ve el mismo componente en el mismo sitio, reusa la instancia y
   * conserva su estado: los mensajes, los agentes y el preview de la sala
   * ANTERIOR. Al entrar a una sala con historial no se notaba, porque el
   * `joined` llegaba con mensajes y pisaba lo viejo; al crear una sala nueva sí,
   * porque llega vacío y nada sobrescribe. Aparecías en una sala recién creada
   * leyendo la conversación de otra.
   */
  return <Sala key={roomId} roomId={roomId} name={name || "anónimo"} />;
}


function NamePrompt(props: {
  roomId: string;
  name: string;
  setName: (n: string) => void;
  onEnter: () => void;
}) {
  const { t } = useTextos();
  return (
    <div className="center-screen">
      <div className="card">
        <p className="sub">{t.vasAEntrar}</p>
        <h2 className="room-name">{props.roomId}</h2>
        <input
          className="name-input"
          placeholder={t.tuNombre}
          value={props.name}
          onChange={(e) => props.setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && props.onEnter()}
          autoFocus
        />
        <button className="cta" onClick={props.onEnter}>
          {t.entrar}
        </button>
      </div>
    </div>
  );
}

// ── La Sala ─────────────────────────────────────────────────────────────────

/**
 * La Sala. Con `roomId` en null se ve el mismo marco pero vacío: es lo que hay
 * al entrar a Multi sin haber elegido sala, con el menú y el botón de crear a
 * la mano.
 */
function Sala({ roomId, name }: { roomId: string | null; name: string }) {
  const { t } = useTextos();
  const [members, setMembers] = useState<Member[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [previewReady, setPreviewReady] = useState(false);
  /** Por dónde va el arranque del preview. null = no está arrancando. */
  const [arrancando, setArrancando] = useState<"contenedor" | "dependencias" | "servidor" | null>(null);
  const [draft, setDraft] = useState("");
  /**
   * El nombre de la sala, o null si nadie la ha nombrado (ahí se ve el id).
   * Es de la sala, así que llega en el `joined` y cambia para todos a la vez.
   */
  const [nombre, setNombre] = useState<string | null>(null);
  const [editandoNombre, setEditandoNombre] = useState(false);
  const [creandoSala, setCreandoSala] = useState(false);
  /** Qué dice el botón de descargar ahora mismo. null = su texto normal. */
  const [zipAviso, setZipAviso] = useState<string | null>(null);
  /**
   * Por dónde va la publicación, o null si no hay ninguna.
   *
   * Es de la SALA, no de quien apretó: llega en el `joined` y por socket, así
   * que quien entre a media publicación ve el progreso igual que los demás.
   */
  const [publicando, setPublicando] = useState<"compilando" | "subiendo" | null>(null);
  /**
   * Si la sala tiene algo guardado que llevarse.
   *
   * Se pregunta al server en vez de deducirlo de `previewReady`: lo que hace
   * exportable a una sala es tener commits, no que su dev server esté arriba.
   * Son cosas distintas y se separan por 20 segundos de arranque de Vite. Atarlo
   * al preview hacía que un proyecto ya commiteado dijera "todavía no hay nada
   * que descargar" mientras su preview levantaba, que es mentira.
   */
  const [sePuedeExportar, setSePuedeExportar] = useState(false);

  const socketRef = useRef<Socket | null>(null);
  // Streaming POR AGENTE: varios pueden estar hablando a la vez.
  const [streaming, setStreaming] = useState<Record<string, string>>({});
  /**
   * Lo que cada agente ha ido haciendo en su turno. Se guarda la lista completa
   * aunque por default solo se vea la última: cuando un turno falla a medias,
   * saber por dónde iba es justo lo que hace falta, y esa información no está en
   * ningún otro lado.
   */
  const [toolLines, setToolLines] = useState<Record<string, string[]>>({});
  /** Agentes cuyo detalle de tools está expandido (click en la línea). */
  const [toolsAbiertas, setToolsAbiertas] = useState<Record<string, boolean>>({});
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
  /**
   * El chat colapsado deja el preview a pantalla completa.
   *
   * Para presentar: la gracia de Multi es ver el chat y la app a la vez, pero
   * cuando enseñas el resultado el chat estorba. La barra de arriba se queda,
   * asi que volver es un click.
   */
  const [chatColapsado, setChatColapsado] = useState(false);
  /**
   * Mi API key. Se lee del navegador al montar: se configura UNA vez y sirve en
   * todas las salas. null = todavía no hay (puedes entrar y platicar igual).
   */
  const [miCred, setMiCred] = useState<Credencial | null>(() => loadStoredCredencial());
  /** El server rechazó la key o avisó que hace falta. */
  const [keyError, setKeyError] = useState<string | null>(null);
  /** Abrir el panel solo: pasa cuando intentas invocar sin key. */
  const [keyAbrir, setKeyAbrir] = useState(false);

  /**
   * Las imágenes que pegaste pero todavía no mandas.
   *
   * Se procesan al pegarlas, no al enviar: encogerlas tarda un momento y hacerlo
   * al darle a Enter dejaría el mensaje colgado sin explicación.
   */
  const [pendientes, setPendientes] = useState<AdjuntoPendiente[]>([]);
  /** Si algo salió mal con una imagen. Solo para quien la pegó. */
  const [errorAdjunto, setErrorAdjunto] = useState<string | null>(null);
  /** Arrastrando un archivo encima del chat. */
  const [arrastrando, setArrastrando] = useState(false);

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
  /** El <input type="file"> escondido que abre el botón de adjuntar. */
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // El iframe apunta al PROXY del server (que inyecta el inspector), no al dev server directo.
  const previewSrc = `${SERVER_URL}/preview/${roomId}`;
  // Origen del proxy, para validar postMessage — cuidado 1.
  const proxyOrigin = new URL(SERVER_URL).origin;

  useEffect(() => {
    // Sin sala no hay a qué conectarse: la Sala vacía es solo el marco con el
    // menú y el botón de crear.
    if (!roomId) return;

    const socket = connectSocket();
    socketRef.current = socket;

    socket.on("connect", () => {
      socket.emit("join", { roomId, name });
      // La key ya configurada viaja sola: no se pide de nuevo en cada sala.
      const guardada = loadStoredCredencial();
      if (guardada) socket.emit("auth:key", guardada);
    });

    socket.on("joined", (p: JoinedPayload) => {
      setMembers(p.members);
      setNombre(p.nombre ?? null);
      recordarNombre(roomId, p.nombre ?? null);
      setPublicando(p.publicando ?? null);
      if (p.previewUrl) setPreviewReady(true);
      if (p.agents) setAgents(p.agents);
      if (p.orphanTurns?.length) setOrphans(p.orphanTurns);
      // El chat que ya existía en la sala (sobrevivió al reinicio).
      if (p.messages?.length) setMessages(p.messages);
      // Llegaste mientras se levantaba: el evento de etapa ya pasó.
      //
      // Solo si NO hay preview todavía. El arranque puede haber terminado antes
      // de que entraras (la sala se despierta sola al primer request), y entonces
      // el `preview:ready` ya pasó y no vuelve: sin esta condición el spinner se
      // quedaba girando encima de un preview que sí existía.
      if (p.previewArrancando && !p.previewUrl) setArrancando("servidor");
    });
    socket.on("presence", ({ members }: { members: Member[] }) => setMembers(members));

    // Alguien de la sala le cambió el nombre: se ve al momento en la cabecera
    // de todos, sin recargar. Quién fue sale en el chat.
    socket.on("room:renamed", ({ nombre }: { nombre: string | null }) => {
      setNombre(nombre);
      recordarNombre(roomId, nombre);
    });

    // La publicación la ve toda la sala. El link y los fallos llegan además al
    // chat, así que aquí solo se mueve el estado del botón.
    socket.on("deploy:progreso", ({ etapa }: { etapa: "compilando" | "subiendo" }) =>
      setPublicando(etapa),
    );
    socket.on("deploy:listo", () => setPublicando(null));
    socket.on("deploy:fallo", () => setPublicando(null));
    socket.on("preview:ready", () => {
      setPreviewReady(true);
      setArrancando(null);
    });
    socket.on("preview:arrancando", ({ etapa }: { etapa: "contenedor" | "dependencias" | "servidor" }) =>
      setArrancando(etapa),
    );
    // El arranque terminó sin preview: la sala sigue vacía o algo falló. Se quita
    // el spinner y vuelve el mensaje de "pídele a un agente que arranque el
    // proyecto", que es lo accionable.
    socket.on("preview:sin-arranque", () => setArrancando(null));
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
        setToolsAbiertas((prev) => {
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
      setToolLines((p) => {
        const previas = p[agentId] ?? [];
        // Tope: un turno largo no debe crecer sin fin en memoria.
        return { ...p, [agentId]: [...previas, summary].slice(-40) };
      }),
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

    // Alguien borró esta sala mientras estabas dentro. Sin esto te quedabas
    // frente a un preview que ya no responde y un chat que no manda nada,
    // sin saber por qué.
    socket.on("room:deleted", () => {
      olvidarSala(roomId);
      alert(t.salaBorrada);
      window.location.hash = "#/";
    });

    // Solo a mí: mi key faltaba o el server la rechazó. Abre el panel.
    socket.on("error:key", ({ message }: { message: string }) => {
      setKeyError(message);
      setKeyAbrir(true);
    });
    socket.on("auth:ok", () => setKeyError(null));

    // Solo a mí: mi imagen no se pudo guardar. El mensaje tampoco salió, así que
    // hay que decirlo o parecería que se envió.
    socket.on("error:adjunto", ({ message }: { message: string }) => {
      setErrorAdjunto(message);
    });

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

  /**
   * Suma imágenes a las que van a salir con el próximo mensaje.
   *
   * El tope de 4 no es capricho: cada imagen cuesta tokens y los paga quien
   * invoque al agente. Cortar aquí es más honesto que dejar mandar diez y que la
   * factura aparezca después.
   */
  const agregarImagenes = async (files: File[]) => {
    if (files.length === 0) return;
    setErrorAdjunto(null);
    const sitio = MAX_ADJUNTOS - pendientes.length;
    if (sitio <= 0) {
      setErrorAdjunto(t.maxImagenes(MAX_ADJUNTOS));
      return;
    }
    try {
      const listas = await Promise.all(files.slice(0, sitio).map(prepararImagen));
      setPendientes((prev) => [...prev, ...listas]);
      if (files.length > sitio) setErrorAdjunto(t.maxImagenes(MAX_ADJUNTOS));
    } catch (err) {
      setErrorAdjunto(err instanceof Error ? err.message : t.imagenNoSePudo);
    }
  };

  const send = () => {
    const text = draft.trim();
    // Mandar solo una imagen, sin escribir nada, es un mensaje legítimo.
    if (!text && pendientes.length === 0) return;
    // Anclar MI selección local al mensaje (cuidado 2/3/4).
    socketRef.current?.emit("chat", {
      text,
      anchor: mySelection,
      adjuntos: pendientes.length
        ? pendientes.map((p) => ({ nombre: p.nombre, mediaType: p.mediaType, data: p.data }))
        : undefined,
    });
    setDraft("");
    setPendientes([]);
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

  /**
   * Publicar la app de la sala.
   *
   * No espera a que termine: el server responde en cuanto arranca y lo demás
   * llega por socket. Un build tarda minutos, y una petición colgada ese rato se
   * moriría por timeout antes de contar nada.
   */
  const publicar = async () => {
    if (!roomId) return;
    setPublicando("compilando"); // respuesta inmediata; el server confirma en seguida
    try {
      const r = await fetch(`${SERVER_URL}/rooms/${roomId}/publicar`, { method: "POST" });
      if (!r.ok) {
        const d = (await r.json().catch(() => null)) as { error?: string } | null;
        setPublicando(null);
        alert(d?.error ?? t.publicarFallo);
      }
    } catch {
      setPublicando(null);
      alert(t.publicarFallo);
    }
  };

  /** Crear otra sala y entrar a ella. El hash es lo que cambia de sala. */
  const crearSala = async () => {
    setCreandoSala(true);
    try {
      window.location.hash = `#/sala/${await createRoom()}`;
    } catch (e) {
      alert(t.noSePudoCrear + String(e));
    } finally {
      setCreandoSala(false);
    }
  };

  /**
   * Guardar el nombre nuevo de la sala.
   *
   * No se pinta aquí lo que quedó: se manda al server y se espera su
   * `room:renamed`, que llega igual para todos. Así el que renombra ve
   * exactamente lo mismo que sus compas, recortes y espacios incluidos.
   */
  const guardarNombre = (valor: string) => {
    setEditandoNombre(false);
    if (valor.trim() === (nombre ?? "")) return; // no cambió: nada que mandar
    socketRef.current?.emit("room:rename", { nombre: valor });
  };

  /**
   * Bajar el proyecto de la sala como .zip.
   *
   * El zip sale del último punto guardado (el último turno cerrado), no del
   * disco. Si hay trabajo a medias se DICE antes de bajarlo, en vez de entregar
   * en silencio algo distinto de lo que se está viendo en el preview.
   *
   * La descarga va por un <a> y no por fetch: así la maneja el navegador con su
   * propia barra de progreso, y un proyecto grande no se carga entero en
   * memoria de la pestaña.
   */
  const descargarZip = async () => {
    setZipAviso(t.preparandoZip);
    try {
      const r = await fetch(`${SERVER_URL}/rooms/${roomId}/export/estado`);
      const estado = (await r.json()) as { hayCommits: boolean; cambiosSinCommitear: boolean };

      if (!estado.hayCommits) {
        setZipAviso(t.zipSalaVacia);
        return;
      }

      const a = document.createElement("a");
      a.href = `${SERVER_URL}/rooms/${roomId}/export`;
      a.download = `${roomId}.zip`;
      a.click();

      setZipAviso(estado.cambiosSinCommitear ? t.zipTrabajoSinGuardar : null);
    } catch {
      setZipAviso(t.zipFallo);
    }
  };

  // El aviso del botón se borra solo: es un mensaje de paso, no un estado en el
  // que la sala se quede.
  useEffect(() => {
    if (!zipAviso || zipAviso === t.preparandoZip) return;
    const id = setTimeout(() => setZipAviso(null), 4000);
    return () => clearTimeout(id);
  }, [zipAviso, t.preparandoZip]);

  /**
   * Si la sala ya tiene algo que llevarse. Se consulta al entrar y cada vez que
   * aparece un punto nuevo en la línea de tiempo (`histVersion`), que es justo
   * cuando una sala vacía deja de estarlo.
   */
  useEffect(() => {
    let cancelado = false;
    fetch(`${SERVER_URL}/rooms/${roomId}/export/estado`)
      .then((r) => (r.ok ? r.json() : null))
      .then((estado: { hayCommits: boolean } | null) => {
        if (!cancelado && estado) setSePuedeExportar(estado.hayCommits);
      })
      .catch(() => {
        // Sin respuesta no se apaga el botón: que el server tarde en contestar no
        // significa que la sala esté vacía, y dejarlo apagado por eso es justo el
        // bug que se está arreglando. Si de verdad no hay nada, el 409 lo dirá.
      });
    return () => {
      cancelado = true;
    };
  }, [roomId, histVersion]);

  return (
    <div className={`sala ${chatColapsado ? "chat-colapsado" : ""}`}>
      {/* Chat izquierda */}
      <aside className="chat">
        <div className="sala-cab">
          <MenuSalas actual={roomId ?? undefined} />
          <div className="sala-titulo">
            {!roomId ? (
              // Sin sala elegida no hay nombre que mostrar ni que editar: la
              // cabecera se queda con el menú y el botón de crear.
              <div className="sala-nombre sala-nombre-vacio">{t.ningunaSala}</div>
            ) : editandoNombre ? (
              <input
                className="sala-nombre-input"
                defaultValue={nombre ?? ""}
                placeholder={roomId}
                maxLength={60}
                autoFocus
                onBlur={(e) => guardarNombre(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  // Escape descarta: se sale sin guardar lo que se llevaba escrito.
                  if (e.key === "Escape") {
                    e.currentTarget.value = nombre ?? "";
                    e.currentTarget.blur();
                  }
                }}
              />
            ) : (
              <button
                className="sala-nombre"
                onClick={() => setEditandoNombre(true)}
                title={nombre ? `${roomId} — ${t.renombrarSala}` : t.renombrarSala}
              >
                {nombre ?? roomId}
              </button>
            )}
            {roomId && <div className="sala-meta">{t.enLaSala(members.length)}</div>}
          </div>
          {/* Crear otra sala, a la vista. Vivía dentro del menú, donde nadie lo
              encontraba: quien ya tenía salas tampoco las veía, así que el único
              camino visible era la portada, y de ahí salían las salas vacías. */}
          <button
            className="sala-nueva"
            onClick={crearSala}
            disabled={creandoSala}
            title={t.crearOtraSala}
            aria-label={t.crearOtraSala}
          >
            +
          </button>
        </div>

        {/* Los agentes de la sala, como jugadores visibles */}
        <AgentList agents={agents} />

        {/* Trabajo que quedó a medias por un crash: decide el humano */}
        {orphans.length > 0 && (
          <div className="orphan-card">
            <div className="orphan-text">
              {t.seInterrumpio(orphans.length)} {t.aMediaTarea}
            </div>
            <div className="orphan-actions">
              <button className="orphan-btn keep" onClick={() => resolveOrphans("keep")}>
                {t.guardarTrabajo}
              </button>
              <button className="orphan-btn" onClick={() => resolveOrphans("revert")}>
                {t.volverAlPunto}
              </button>
            </div>
          </div>
        )}

        <div className="chat-scroll">
          {messages.map((m, i) => (
            // Mensajes seguidos del mismo autor se agrupan sin repetir avatar
            // ni nombre (patrón Discord): el chat respira y se lee como
            // conversación, no como lista de tarjetas.
            // Sin sala no hay mensajes que pintar, así que aquí siempre lo hay.
            <ChatRow key={i} msg={m} seguido={esSeguido(messages, i)} roomId={roomId!} />
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
                  {toolLines[agentId]?.length ? (
                    <ToolTrace
                      lineas={toolLines[agentId]}
                      abierto={!!toolsAbiertas[agentId]}
                      onToggle={() =>
                        setToolsAbiertas((p) => ({ ...p, [agentId]: !p[agentId] }))
                      }
                    />
                  ) : null}
                  {streaming[agentId] && <div className="burbuja">{streaming[agentId]}</div>}
                </div>
              </div>
            );
          })}
        </div>

        <div
          className={`chat-input ${arrastrando ? "arrastrando" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setArrastrando(true);
          }}
          onDragLeave={(e) => {
            // Solo al salir del contenedor entero, no al cruzar sus hijos.
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
              setArrastrando(false);
            }
          }}
          onDrop={(e) => {
            e.preventDefault();
            setArrastrando(false);
            void agregarImagenes(imagenesDe(e.dataTransfer));
          }}
        >
          {mySelection && (
            <div className="anchor-chip">
              anclado a &lt;{mySelection.tag}&gt;{mySelection.text ? ` "${mySelection.text.slice(0, 24)}"` : ""}
              <span className="anchor-x" onClick={() => { setMySelection(null); postToInspector({ type: "selection:clear" }); }}>
                ×
              </span>
            </div>
          )}
          {pendientes.length > 0 && (
            <div className="adjuntos-pendientes">
              {pendientes.map((p, i) => (
                <div className="adjunto-chip" key={i} title={p.nombre}>
                  <img src={p.previewUrl} alt={p.nombre} />
                  <span
                    className="adjunto-x"
                    onClick={() => setPendientes((prev) => prev.filter((_, j) => j !== i))}
                    title={t.quitarImagen}
                  >
                    ×
                  </span>
                </div>
              ))}
            </div>
          )}
          {errorAdjunto && (
            <div className="adjunto-error" onClick={() => setErrorAdjunto(null)}>
              {errorAdjunto}
            </div>
          )}
          <div className="input-wrap">
            {mention !== null && (
              <MentionMenu agents={agents} query={mention} onPick={pickMention} />
            )}
            {/* Arrastrar y pegar ya funcionaban, pero no se ven: nadie adivina
                que puede soltar un archivo aquí. Y en el teléfono no existe
                ninguna de las dos, así que sin esto no hay forma de subir nada. */}
            <input
              ref={fileInputRef}
              type="file"
              accept={ACEPTADOS.join(",")}
              multiple
              style={{ display: "none" }}
              onChange={(e) => {
                void agregarImagenes(Array.from(e.target.files ?? []).filter(esImagenAceptada));
                // Se limpia para que elegir el MISMO archivo dos veces seguidas
                // vuelva a disparar onChange.
                e.target.value = "";
              }}
            />
            <button
              className="adjuntar-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={!roomId}
              title={t.adjuntarImagen}
              aria-label={t.adjuntarImagen}
            >
              {/* Un clip, no un "+": el más ya es crear sala, ahí arriba, y dos
                  botones con el mismo símbolo en la misma pantalla se confunden.
                  Va en SVG y no como emoji para que se vea igual en todos lados. */}
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <input
              ref={inputRef}
              className="caja"
              // Sin sala no hay a dónde mandar nada: se apaga en vez de dejar
              // escribir un mensaje que se perdería al darle enter.
              disabled={!roomId}
              placeholder={roomId ? t.hablaConLaSala : t.eligeOCrea}
              value={draft}
              onChange={(e) => onDraftChange(e.target.value)}
              onPaste={(e) => {
                const imgs = imagenesDe(e.clipboardData);
                // Solo se intercepta si de verdad venían imágenes: pegar texto
                // tiene que seguir funcionando igual que siempre.
                if (imgs.length) {
                  e.preventDefault();
                  void agregarImagenes(imgs);
                }
              }}
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
            className="colapsar-btn"
            onClick={() => setChatColapsado((v) => !v)}
            title={chatColapsado ? t.mostrarChat : t.ocultarChat}
            aria-label={chatColapsado ? t.mostrarChat : t.ocultarChat}
          >
            {chatColapsado ? "⟩" : "⟨"}
          </button>
          <button
            className={`inspect-btn ${inspect ? "on" : ""}`}
            onClick={() => setInspect((v) => !v)}
            disabled={!roomId}
            title={t.tituloSelector}
          >
            {inspect ? t.seleccionando : t.seleccionarBtn}
          </button>
          <div className="presencia">
            {members.map((m) => (
              <div key={m.socketId} className="av" style={{ background: m.color }} title={m.name}>
                {m.name.slice(0, 1).toUpperCase()}
              </div>
            ))}
            {/* La `key` cambia cuando el server pide la API key: remonta el
                panel para que se abra solo en ese momento. */}
            <KeyPanel
              key={keyAbrir ? "abierto" : "cerrado"}
              actual={miCred}
              abiertoPorDefecto={keyAbrir}
              error={keyError}
              onGuardar={(c) => {
                socketRef.current?.emit("auth:key", c);
                setMiCred(c);
                setKeyAbrir(false);
              }}
              onOlvidar={() => {
                socketRef.current?.emit("auth:forget");
                setMiCred(null);
                setKeyError(null);
              }}
            />
            <button
              className="invitar"
              onClick={descargarZip}
              disabled={!sePuedeExportar || zipAviso === t.preparandoZip}
              title={sePuedeExportar ? t.descargarZip : t.zipSalaVacia}
            >
              {zipAviso ?? t.descargarZip}
            </button>
            {/* Publicar tarda minutos, así que el botón dice por dónde va en
                lugar de quedarse quieto: mismo trato que el de descargar. */}
            <button
              className="invitar"
              onClick={publicar}
              disabled={!sePuedeExportar || !!publicando}
              title={sePuedeExportar ? t.publicarTitulo : t.zipSalaVacia}
            >
              {publicando ? t.etapaDeploy[publicando] : t.publicar}
            </button>
            {/* Las variables son del proyecto de la sala, así que sin sala no
                hay dónde escribirlas. */}
            {roomId && <EnvPanel roomId={roomId} />}
            {/* Sin sala no hay link que compartir: copiaría la URL pelada. */}
            <button className="invitar" onClick={copyLink} disabled={!roomId}>
              {t.copiarLink}
            </button>
          </div>
        </div>

        <div className="tabs">
          <button className={`tab ${tab === "app" ? "activa" : ""}`} onClick={() => setTab("app")}>
            {t.laApp}
          </button>
          <button className={`tab ${tab === "back" ? "activa" : ""}`} onClick={() => setTab("back")}>
            {t.elBack}
          </button>
        </div>

        {tab === "back" && roomId && (
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
                title={t.tituloPreview}
              />
              {/* Selecciones de OTROS (con su color/nombre). Nota: se dibujan
                  como badges de aviso; el outline exacto vive dentro del iframe. */}
              <div className="others-selections">
                {Object.values(selections).map((s) => (
                  <div key={s.socketId} className="sel-badge" style={{ borderColor: s.color, color: s.color }}>
                    {s.name} {t.selecciono} &lt;{s.element?.tag}&gt;
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="preview-loading">
              {arrancando ? (
                <>
                  <div className="preview-spinner" aria-hidden="true" />
                  <p>{t.levantandoPreview}</p>
                  <p className="preview-loading-sub">{t.etapaPreview[arrancando]}</p>
                </>
              ) : !roomId ? (
                // Ni siquiera hay sala: lo que falta no es pedirle algo a un
                // agente, es elegir dónde.
                <>
                  <p>{t.ningunaSala}</p>
                  <p className="preview-loading-sub">{t.eligeOCrea}</p>
                </>
              ) : (
                <>
                  <p>{t.salaVacia}</p>
                  <p className="preview-loading-sub">
                    {t.pideleAlAgente}
                    <br />
                    {t.porEjemplo} <code>{t.pideAlgo}</code>
                  </p>
                </>
              )}
            </div>
          )}

          {/* Cursores de otros sobre el escenario */}
          {Object.values(cursors).map((c) => (
            // `color` en el contenedor: la flecha y la etiqueta lo heredan por
            // currentColor, así cada quien trae el suyo sin repetirlo.
            <div
              key={c.socketId}
              className="remote-cursor"
              style={{ left: c.x, top: c.y, color: c.color }}
            >
              <span className="cursor-flecha" />
              <span className="cursor-name">
                <span>{c.name}</span>
              </span>
            </div>
          ))}
        </div>

        {/* La línea de tiempo de la sala. Sin sala no hay historial que pintar. */}
        {roomId && (
          <Historial
            roomId={roomId}
            version={histVersion}
            onRevert={(hash, file) => socketRef.current?.emit("history:revert", { hash, file })}
            onBookmark={(hash, label) => socketRef.current?.emit("history:bookmark", { hash, label })}
          />
        )}
      </section>
    </div>
  );
}

/**
 * ¿Este mensaje continúa al anterior? Mismo autor, mismo rol, y ninguno de los
 * dos es del sistema (los avisos siempre se ven aparte). Los anclados tampoco
 * se agrupan: llevan su propia nota de contexto.
 */
function esSeguido(msgs: ChatMessage[], i: number): boolean {
  if (i === 0) return false;
  const prev = msgs[i - 1];
  const m = msgs[i];
  if (m.role === "system" || prev.role === "system") return false;
  if (m.anchoredTo) return false;
  return prev.from === m.from && prev.role === m.role;
}

function ChatRow({
  msg,
  seguido,
  roomId,
}: {
  msg: ChatMessage;
  seguido?: boolean;
  roomId: string;
}) {
  const initial = msg.from.slice(0, msg.role === "agent" ? 2 : 1).toUpperCase();

  /**
   * Las imágenes se piden al server por su URL en vez de venir en el mensaje.
   * Así el navegador las cachea (el id es un uuid, nunca cambia) y entrar a una
   * sala con historial largo no arrastra megas de base64.
   */
  const adjuntos = msg.adjuntos?.length ? (
    <div className="adjuntos-msg">
      {msg.adjuntos.map((a) => (
        <a
          key={a.id}
          href={`${SERVER_URL}/rooms/${roomId}/adjuntos/${a.id}`}
          target="_blank"
          rel="noreferrer"
        >
          <img src={`${SERVER_URL}/rooms/${roomId}/adjuntos/${a.id}`} alt={a.nombre} />
        </a>
      ))}
    </div>
  ) : null;

  // Continuación: solo el texto, alineado bajo el mensaje anterior.
  if (seguido) {
    return (
      <div className="msg-seguido">
        {msg.text && <div className="burbuja">{msg.text}</div>}
        {adjuntos}
      </div>
    );
  }

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
            {msg.role === "agent" && <span className="tag-ai">agente</span>}
          </div>
        )}
        {msg.anchoredTo && <div className="anchor-note">sobre: {msg.anchoredTo}</div>}
        {msg.text && (
          <div className={msg.role === "system" ? "system-text" : "burbuja"}>{msg.text}</div>
        )}
        {adjuntos}
      </div>
    </div>
  );
}

/**
 * Lo que el agente va haciendo. Por default solo la última línea — la UI se
 * mantiene limpia y no crece mientras trabaja.
 *
 * Se puede expandir con un click porque cuando un turno falla a media chamba,
 * saber por dónde iba es justo lo que hace falta, y esa información no está en
 * ningún otro lado: sin esto la línea se sobrescribía y lo anterior se perdía.
 */
function ToolTrace(props: { lineas: string[]; abierto: boolean; onToggle: () => void }) {
  const { t } = useTextos();
  const ultima = props.lineas[props.lineas.length - 1];
  const previas = props.lineas.length - 1;

  if (!props.abierto) {
    return (
      <div className="tool-line tool-line-click" onClick={props.onToggle}>
        {ultima}
        {previas > 0 && <span className="tool-mas">+{previas}</span>}
      </div>
    );
  }

  return (
    <div className="tool-trace" onClick={props.onToggle}>
      {props.lineas.map((l, i) => (
        <div className="tool-line" key={i}>
          {l}
        </div>
      ))}
      <div className="tool-cerrar">{t.contraer}</div>
    </div>
  );
}
