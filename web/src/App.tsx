import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import type { Socket } from "socket.io-client";
import {
  connectSocket,
  createRoom,
  SERVER_URL,
  type ChatMessage,
  type Member,
  type JoinedPayload,
  type ModoDeSala,
  type SelectedElement,
  type CursorInfo,
  type SelectionInfo,
  type Agent,
  type OrphanTurn,
} from "./socket.js";
import { AgentList, textoDeEstado } from "./AgentList.js";
import { FiltroChat } from "./FiltroChat.js";
import { MentionMenu } from "./MentionMenu.js";
import { Historial } from "./Historial.js";
// El panel ya no se monta, pero la key guardada del navegador se sigue
// mandando al conectar: quien la había configurado no debe quedarse fuera.
import { loadStoredCredencial } from "./KeyPanel.js";
import { EnvPanel, type EstadoSupabase } from "./EnvPanel.js";
import { PublicarPanel } from "./PublicarPanel.js";
import { useTextos } from "./i18n.js";
import { MenuSalas } from "./MenuSalas.js";
import { recordarSala, olvidarSala, recordarNombre, guardarSalas, siguienteLlave } from "./historial-salas.js";
import { CuentaPanel } from "./CuentaPanel.js";
import {
  quienSoy,
  sincronizarSalas,
  volverDondeEstaba,
  urlDeFoto,
  type EstadoDeCuenta,
  type Usuario,
} from "./cuenta.js";
import {
  prepararParaSubir,
  subirAdjunto,
  esPdf,
  imagenesDe,
  esImagenAceptada,
  ACEPTADOS,
  type AdjuntoPendiente,
} from "./imagenes.js";

/** Cuántas imágenes caben en un mensaje. El server aplica el mismo tope. */
const MAX_ADJUNTOS = 4;

/**
 * Hasta dónde crece la caja del chat antes de hacer scroll adentro.
 *
 * Unas ocho líneas. Más que eso y la caja se come el chat, que es lo que la
 * persona está leyendo mientras escribe.
 */
const ALTO_MAXIMO_CAJA = 180;

/**
 * A qué ancho se mira el preview.
 *
 * Un solo botón las cicla en este orden, en vez de tres botones en la barra:
 * ya hay siete controles ahí arriba y este se toca poco.
 *
 * Los anchos son los de siempre para cada clase de pantalla; lo que importa no
 * es el número exacto sino cruzar los puntos donde un layout se rompe.
 */
const VISTAS = ["escritorio", "tablet", "movil"] as const;
type Vista = (typeof VISTAS)[number];

const ANCHO_DE_VISTA: Record<Vista, string | undefined> = {
  // Sin ancho: el preview ocupa lo que haya, como siempre.
  escritorio: undefined,
  tablet: "768px",
  movil: "390px",
};

// El roomId vive en el hash de la URL: #/sala/taco-fiesta-42
function readRoomFromHash(): string | null {
  const m = window.location.hash.match(/#\/sala\/([\w-]+)/);
  return m ? m[1] : null;
}

/** La `key` de la Sala. La regla vive en `siguienteLlave`, con su porqué. */

function usarLlaveDeLaSala(roomId: string | null): string {
  const llave = useRef("sala");
  const anterior = useRef<string | null>(roomId);
  if (anterior.current !== roomId) {
    llave.current = siguienteLlave(llave.current, anterior.current, roomId);
    anterior.current = roomId;
  }
  return llave.current;
}

/**
 * Cómo te llamas, de este navegador.
 *
 * La clave vieja usaba guion (`multi-name`) mientras el resto del proyecto usa
 * punto. Se lee una última vez y se reescribe con la nueva: sin esto, todo el
 * que ya venía usando Multi volvería a ver la pantalla del nombre de golpe.
 */
function nombreGuardado(): string {
  try {
    const actual = localStorage.getItem("multi.nombre");
    if (actual) return actual;
    const viejo = localStorage.getItem("multi-name");
    if (viejo) {
      localStorage.setItem("multi.nombre", viejo);
      localStorage.removeItem("multi-name");
      return viejo;
    }
  } catch {
    // Sin localStorage se pregunta el nombre otra vez. No es motivo para no entrar.
  }
  return "";
}

export function App() {
  const [roomId, setRoomId] = useState<string | null>(readRoomFromHash());
  const [name, setName] = useState<string>(nombreGuardado());

  /**
   * La cuenta, si es que hay una. `null` es el caso normal y mayoritario.
   *
   * Ojo con lo que NO se hace aquí: no se espera a esta respuesta para pintar
   * la app. Mientras llega, se entra como siempre. Si se pusiera una pantalla
   * de carga esperándola, el login se habría vuelto un peaje para todos, aunque
   * nadie tenga cuenta.
   */
  const [cuenta, setCuenta] = useState<EstadoDeCuenta>({ configurado: false, usuario: null });

  useEffect(() => {
    void quienSoy().then((estado) => {
      setCuenta(estado);
      if (!estado.usuario) return;
      // Con cuenta, el perfil manda sobre el nombre local.
      setName(estado.usuario.nombre);
      volverDondeEstaba();
      // Las salas de este navegador suben a la cuenta, y las de la cuenta bajan.
      void sincronizarSalas().then(guardarSalas);
    });
  }, []);

  /**
   * Alguien cambió su nombre o su foto desde el panel.
   *
   * El nombre local se mueve con él para que el chat y la presencia lo usen sin
   * esperar a recargar. El server ya avisó a los demás de la sala por su cuenta.
   */
  const onCuentaCambio = useCallback((u: Usuario) => {
    setCuenta((antes) => ({ ...antes, usuario: u }));
    setName(u.nombre);
  }, []);

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
  const [entered, setEntered] = useState(() => !!nombreGuardado());

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

  const llave = usarLlaveDeLaSala(roomId);

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
  if (!roomId) return <Sala key={llave} roomId={null} name={name || "anónimo"} cuenta={cuenta} onCuentaCambio={onCuentaCambio} />;

  // Hay sala pero falta decir cómo te llamas. Sigue haciendo falta para quien
  // llega por un link que le pasaron: la sala necesita saber quién entró.
  // Con cuenta no se pregunta el nombre: ya lo sabemos, y con foto.
  if (!entered && !cuenta.usuario) {
    return (
      <NamePrompt
        roomId={roomId}
        name={name}
        setName={setName}
        onEnter={() => {
          localStorage.setItem("multi.nombre", name || "anónimo");
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
   * La `key` la decide `usarLlaveDeLaSala`, arriba: cambia entre una sala y otra
   * para empezar de cero, y NO cambia al pasar de la portada a su sala.
   */
  return <Sala key={llave} roomId={roomId} name={name || "anónimo"} cuenta={cuenta} onCuentaCambio={onCuentaCambio} />;
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
/**
 * Lo que se puede pedir, uno a la vez y rotando.
 *
 * La sala vacía enseñaba un solo ejemplo, siempre el mismo y siempre una
 * página. Quien llegaba no tenía forma de saber que también puede pedir una
 * presentación o un juego, y de los cuatro primeros que llegaron solos, tres
 * venían justo a hacer presentaciones.
 *
 * Rota en vez de listar los cinco: leer una lista es trabajo, y lo que hace
 * falta aquí es una idea, no un menú.
 */
function Ejemplos({ modo }: { modo: ModoDeSala }) {
  const { t } = useTextos();
  const [i, setI] = useState(0);

  useEffect(() => {
    // Quien pidió menos movimiento no quiere un texto cambiando solo cada tres
    // segundos. Se queda con el primero, que es el que más gente necesita ver.
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const cada = setInterval(() => setI((n) => (n + 1) % t.ejemplos.length), 3200);
    return () => clearInterval(cada);
  }, [t.ejemplos.length]);

  // En multi la arroba va pegada al ejemplo: ahí SÍ hace falta, y enseñarla
  // dentro de algo que se puede copiar tal cual es lo que la explica.
  const arroba = modo === "multi" ? "@agente " : "";

  return (
    <p className="preview-loading-sub">
      {t.construyeAlgoComo}
      <br />
      {/* La key fuerza el remonte, y con él la animación de entrada: sin ella
          React reusa el nodo, cambia el texto y el cambio pasa desapercibido. */}
      <code key={i} className="ejemplo-rotando">
        {arroba}
        {t.ejemplos[i]}
      </code>
    </p>
  );
}

function Sala({
  roomId,
  name,
  cuenta,
  onCuentaCambio,
}: {
  roomId: string | null;
  name: string;
  cuenta: EstadoDeCuenta;
  onCuentaCambio: (u: Usuario) => void;
}) {
  const { t } = useTextos();
  const [members, setMembers] = useState<Member[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [previewReady, setPreviewReady] = useState(false);
  /** Por dónde va el arranque del preview. null = no está arrancando. */
  const [arrancando, setArrancando] = useState<"contenedor" | "dependencias" | "servidor" | null>(null);
  /**
   * El iframe está cargando el HTML del proyecto.
   *
   * Es una espera distinta de la de `arrancando`: ahí el dev server todavía no
   * existe y hay un spinner con la etapa. Aquí el preview ya está listo y lo que
   * tarda es el navegador, así que el spinner ya se fue y el iframe se queda en
   * blanco sin que nada diga que algo está pasando.
   */
  const [cargandoFrame, setCargandoFrame] = useState(false);

  /**
   * Ya llegó el estado de la sala (el `joined`).
   *
   * Sin esto, entre que el socket conecta y el server responde, el chat vacío se
   * ve IGUAL que una sala donde nadie ha hablado. Con internet lento eso son
   * varios segundos, y en las sesiones con estudiantes fue lo más reportado:
   * recargaban, veían todo en blanco y creían que habían perdido su trabajo.
   * Nadie perdió nada, faltaba decirles que estaban esperando.
   */
  const [unido, setUnido] = useState(false);

  /**
   * Escribió sin mencionar al agente y está solo: el server lo avisa y aquí se
   * pinta hasta que mande otra cosa. Que reaccione es la señal de que ya lo vio.
   */
  const [pistaMencion, setPistaMencion] = useState(false);

  /**
   * Ya pasó el tiempo suficiente como para que valga la pena decir "cargando".
   *
   * Con conexión buena el `joined` llega en milisegundos, y un indicador que
   * aparece y desaparece en ese rato es peor que no poner nada: parpadea en cada
   * entrada a una sala, incluso en una recién creada que sabemos vacía. Este
   * retraso deja pasar el caso rápido en silencio, que es el común, y solo habla
   * cuando la espera de verdad se siente.
   */
  const [esperaLarga, setEsperaLarga] = useState(false);
  useEffect(() => {
    if (unido || !roomId) {
      setEsperaLarga(false);
      return;
    }
    const t = setTimeout(() => setEsperaLarga(true), 600);
    return () => clearTimeout(t);
  }, [unido, roomId]);
  const [draft, setDraft] = useState("");
  /**
   * El nombre de la sala, o null si nadie la ha nombrado (ahí se ve el id).
   * Es de la sala, así que llega en el `joined` y cambia para todos a la vez.
   */
  const [nombre, setNombre] = useState<string | null>(null);
  /**
   * Si en esta sala hay que mencionar al agente para despertarlo.
   *
   * Null mientras el server no lo ha dicho, y esa distinción importa: antes
   * arrancaba en "multi" por prudencia, y como el `joined` tarda un par de
   * segundos en llegar, lo PRIMERO que leía quien abría una sala nueva era que
   * escribiera @agente. Justo lo que el modo de una persona vino a quitar, y
   * encima en el único momento en que alguien lee esa pantalla.
   *
   * Con null, los textos que dependen del modo no se pintan hasta saberlo.
   */
  const [modo, setModo] = useState<ModoDeSala | null>(null);
  const [editandoNombre, setEditandoNombre] = useState(false);
  const [creandoSala, setCreandoSala] = useState(false);
  /** El botón de compartir acaba de copiar. Se apaga solo. */
  const [copiado, setCopiado] = useState(false);
  /** Si el historial está abierto. Cerrado por defecto: se consulta de vez en
      cuando, y abajo del preview se llevaba una franja de la pantalla siempre. */
  const [histAbierto, setHistAbierto] = useState(false);
  /** Qué dice el botón de descargar ahora mismo. null = su texto normal. */
  /**
   * Por dónde va la publicación, o null si no hay ninguna.
   *
   * Es de la SALA, no de quien apretó: llega en el `joined` y por socket, así
   * que quien entre a media publicación ve el progreso igual que los demás.
   */
  const [publicando, setPublicando] = useState<"compilando" | "subiendo" | null>(null);
  /**
   * Dónde está publicada la app, o null si nunca se publicó.
   *
   * Viene de la BD en el `joined`, así que sigue ahí mañana: el link es un dato
   * de la sala, no un mensaje de hace rato.
   */
  const [urlPublicada, setUrlPublicada] = useState<string | null>(null);
  /**
   * La base de datos de la sala.
   *
   * Arranca sin configurar y se consulta al entrar: así, si quien hospeda este
   * Multi no puso la integración, el bloque no aparece nunca y nadie descubre
   * un botón que no lleva a ningún lado.
   */
  const [supabase, setSupabase] = useState<EstadoSupabase>({
    configurado: false,
    proyecto: null,
  });
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
  /**
   * El primer mensaje, escrito antes de que la sala existiera.
   *
   * Espera aquí a que llegue el `joined`, que es la señal de que el server ya
   * tiene la sala puesta. Antes de eso, un `chat` se descarta sin avisar a
   * nadie: pasa cuando la sala no está en memoria (dormida, o el server recién
   * reiniciado) y su `join` se va a esperar mientras el mensaje se cuela.
   *
   * Es un ref y no estado porque quien lo lee es el handler del socket, que se
   * registra una sola vez y se quedaría con el valor de entonces.
   */
  const porMandar = useRef<{ text: string } | null>(null);
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
  /**
   * Quiénes están seleccionados en el filtro del chat, por NOMBRE.
   *
   * Vacío significa sin filtro, que es distinto de "nadie seleccionado": con
   * cinco personas hablando, arrancar con el chat en blanco sería peor que el
   * caos que esto viene a resolver.
   *
   * Por nombre y no por id porque es lo único que trae el mensaje: `from` es el
   * nombre visible del autor, y coincide con `member.name` y con `agent.name`.
   * El costo es que dos personas con el mismo nombre quedan indistinguibles —
   * el server no los deduplica.
   */
  const [filtro, setFiltro] = useState<Set<string>>(new Set());
  const mensajesVisibles = useMemo(
    () => messages.filter((m) => pasaElFiltro(m, filtro)),
    [messages, filtro],
  );
  const ocultos = messages.length - mensajesVisibles.length;

  /**
   * Los agentes que están en algo, como objeto para poder mezclarlos con
   * `streaming` y `toolLines` sin duplicar a nadie: las tres fuentes se indexan
   * por agentId, así que el spread las deduplica solo.
   */
  const trabajando = useMemo(
    () => Object.fromEntries(agents.filter((a) => a.state !== "idle").map((a) => [a.id, true])),
    [agents],
  );

  /**
   * Quiénes se pueden filtrar: los que están conectados MÁS los que hablaron.
   *
   * No basta con `members`: esa lista es de quien está AHORA, y quien cerró la
   * pestaña desaparece de ahí aunque sus mensajes sigan en el chat. Filtrar por
   * alguien que ya se fue es justo lo que se quiere poder hacer — es su
   * conversación la que hay que poder aislar.
   *
   * Los que siguen dentro conservan su color real; a los que se fueron se les
   * saca del propio mensaje, que ya lo trae.
   */
  const filtrables = useMemo(() => {
    const vistos = new Map<string, { nombre: string; color: string; agente: boolean }>();
    for (const m of members) {
      vistos.set(m.name, { nombre: m.name, color: m.color, agente: false });
    }
    for (const a of agents) {
      vistos.set(a.name, { nombre: a.name, color: a.color, agente: true });
    }
    for (const msg of messages) {
      if (msg.role === "system") continue;
      if (vistos.has(msg.from)) continue;
      vistos.set(msg.from, {
        nombre: msg.from,
        color: msg.color,
        agente: msg.role === "agent",
      });
    }
    return [...vistos.values()];
  }, [members, agents, messages]);
  const alternarFiltro = useCallback((nombre: string) => {
    setFiltro((prev) => {
      const siguiente = new Set(prev);
      if (!siguiente.delete(nombre)) siguiente.add(nombre);
      return siguiente;
    });
  }, []);
  const [orphans, setOrphans] = useState<OrphanTurn[]>([]);
  /** Query del menú de menciones (null = cerrado). */
  const [mention, setMention] = useState<string | null>(null);
  /** Se incrementa cuando el historial cambia, para que el scrubber recargue. */
  const [histVersion, setHistVersion] = useState(0);
  /** Qué tab del escenario se ve. */
  /**
   * Qué se está viendo. "chat" solo existe en pantallas chicas, donde el chat
   * no cabe al lado del preview y pasa a ser una vista más.
   */
  const [tab, setTab] = useState<"chat" | "app">("app");
  /**
   * A qué ancho se está viendo el preview.
   *
   * Es solo del que mira: cambiarlo no le mueve nada a los demás de la sala, ni
   * toca la app. Se angosta el marco, no el proyecto.
   */
  const [vista, setVista] = useState<Vista>("escritorio");
  /**
   * El chat colapsado deja el preview a pantalla completa.
   *
   * Para presentar: la gracia de Multi es ver el chat y la app a la vez, pero
   * cuando enseñas el resultado el chat estorba. La barra de arriba se queda,
   * asi que volver es un click.
   */
  /**
   * Qué tan ancho está el chat, en píxeles.
   *
   * Arrastrable en vez de un botón de colapsar: el reparto bueno entre chat y
   * preview depende de lo que estés haciendo y de tu pantalla, y un botón solo
   * ofrecía todo o nada. Se recuerda en este navegador, que es donde importa.
   */
  const [anchoChat, setAnchoChat] = useState<number>(() => {
    const guardado = Number(localStorage.getItem("multi.ancho-chat"));
    return guardado >= 280 && guardado <= 900 ? guardado : 460;
  });
  const moviendoDivisor = useRef(false);
  /**
   * Mi API key. Se lee del navegador al montar: se configura UNA vez y sirve en
   * todas las salas. null = todavía no hay (puedes entrar y platicar igual).
   */
  /** El server rechazó la key o avisó que hace falta. */
  /** Abrir el panel solo: pasa cuando intentas invocar sin key. */

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
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  /**
   * La caja crece con lo que escribes, hasta un tope.
   *
   * Era un <input> de una línea, así que un mensaje largo se iba de lado y solo
   * se veía el final: para releer lo que llevabas había que hacer scroll
   * horizontal. El alto se pone en `auto` ANTES de medir porque scrollHeight no
   * baja solo, y sin eso la caja crece con cada tecla y ya nunca se encoge al
   * borrar.
   */
  useEffect(() => {
    const caja = inputRef.current;
    if (!caja) return;
    caja.style.height = "auto";
    caja.style.height = `${Math.min(caja.scrollHeight, ALTO_MAXIMO_CAJA)}px`;
  }, [draft]);
  /** El <input type="file"> escondido que abre el botón de adjuntar. */
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // El iframe apunta al PROXY del server (que inyecta el inspector), no al dev server directo.
  const previewSrc = `${SERVER_URL}/preview/${roomId}`;
  // Cada vez que cambia a qué apunta el iframe, vuelve a estar cargando.
  useEffect(() => {
    if (previewReady) setCargandoFrame(true);
  }, [previewSrc, previewReady]);
  // Origen del proxy, para validar postMessage — cuidado 1.
  const proxyOrigin = new URL(SERVER_URL).origin;

  useEffect(() => {
    // Sin sala no hay a qué conectarse: la Sala vacía es solo el marco con el
    // menú y el botón de crear.
    if (!roomId) return;

    // Cambiar de sala deja el estado de la anterior: sin esto, entrar a una
    // segunda sala la pinta como si ya se supiera qué hay dentro.
    setUnido(false);

    const socket = connectSocket();
    socketRef.current = socket;

    // Se cayó la conexión. Socket.io reconecta solo, así que esto no arregla
    // nada: solo evita que la sala se vea normal mientras ya no llega nada.
    socket.on("disconnect", () => setUnido(false));

    // Le habló al vacío. La pista llega solo a quien escribió y no se guarda.
    socket.on("pista:mencion", () => setPistaMencion(true));

    socket.on("connect", () => {
      socket.emit("join", { roomId, name });
      // La key ya configurada viaja sola: no se pide de nuevo en cada sala.
      const guardada = loadStoredCredencial();
      if (guardada) socket.emit("auth:key", guardada);
    });

    socket.on("joined", (p: JoinedPayload) => {
      setUnido(true);
      setMembers(p.members);
      setNombre(p.nombre ?? null);
      setModo(p.modo ?? "multi");
      recordarNombre(roomId, p.nombre ?? null);
      setPublicando(p.publicando ?? null);
      setUrlPublicada(p.urlPublicada ?? null);
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

      // El mensaje con el que nació la sala. Aquí, y no en el `connect`: si la
      // sala estaba dormida, su `join` pasa por un await antes de quedar puesta
      // y un `chat` adelantado se pierde en silencio.
      const primero = porMandar.current;
      if (primero) {
        porMandar.current = null;
        socket.emit("chat", { text: primero.text });
        setDraft("");
      }
    });
    socket.on("presence", ({ members }: { members: Member[] }) => setMembers(members));

    // Alguien de la sala le cambió el nombre: se ve al momento en la cabecera
    // de todos, sin recargar. Quién fue sale en el chat.
    // Lo manda el server cuando alguien lo cambia, y también solo, cuando entra
    // una segunda persona y la sala deja de ser de una.
    socket.on("room:modo", ({ modo }: { modo: ModoDeSala }) => setModo(modo));

    socket.on("room:renamed", ({ nombre }: { nombre: string | null }) => {
      setNombre(nombre);
      recordarNombre(roomId, nombre);
    });

    // Crear una base tarda minutos, así que el server va contando por dónde va.
    // Lo ve toda la sala a propósito: es del proyecto, no de quien apretó.
    socket.on("supabase:etapa", (d: { etapa: EstadoSupabase["etapa"]; segundos?: number }) => {
      setSupabase((s) => ({ ...s, etapa: d.etapa, segundos: d.segundos, error: null }));
    });

    socket.on(
      "supabase:listo",
      (d: { proyecto: string; password?: string }) => {
        setSupabase((s) => ({
          ...s,
          proyecto: d.proyecto,
          etapa: null,
          // La contraseña vive SOLO en este estado de React: al recargar se va, y
          // eso es lo correcto. Supabase no la devuelve nunca, así que guardarla
          // en el navegador sería dejarla tirada donde nadie la vigila.
          password: d.password ?? null,
        }));
      },
    );

    socket.on("supabase:fallo", (d: { error: string }) => {
      setSupabase((s) => ({ ...s, etapa: null, error: d.error }));
    });

    socket.on("supabase:desconectado", () => {
      setSupabase((s) => ({ ...s, proyecto: null, etapa: null, password: null, error: null }));
    });

    // La publicación la ve toda la sala. El link y los fallos llegan además al
    // chat, así que aquí solo se mueve el estado del botón.
    socket.on("deploy:progreso", ({ etapa }: { etapa: "compilando" | "subiendo" }) =>
      setPublicando(etapa),
    );
    socket.on("deploy:listo", ({ url }: { url: string }) => {
      setPublicando(null);
      setUrlPublicada(url);
    });
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

    // Falta la key o el server la rechazó. Se registra en la consola y no se
    // le enseña a nadie: con el respaldo del .env puesto esto no pasa, y si
    // pasara, quien lo puede resolver es quien hospeda este Multi, no quien
    // está escribiendo. Un aviso sobre credenciales a media sala solo asusta a
    // alguien que no puede hacer nada al respecto.
    socket.on("error:key", ({ message }: { message: string }) => {
      console.error("[multi] el server no pudo usar una key:", message);
    });

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
   * Crear la sala y entrar a ella, con lo que se haya escrito bajo el brazo.
   *
   * Es lo que pasa al escribir en Multi sin haber elegido sala: el mensaje es lo
   * que la crea, y lo único que se ve es que la URL cambia. Antes la caja estaba
   * apagada y había que adivinar que primero se creaba con el `+`.
   *
   * El texto viaja en un ref en vez de mandarse aquí porque el socket todavía no
   * existe: lo levanta el efecto cuando cambia `roomId`, y el mensaje sale al
   * llegar el `joined`.
   */
  const nacerConMensaje = async (text: string): Promise<string | null> => {
    // Dos enters seguidos crearían dos salas, y la segunda se quedaría vacía.
    if (creandoSala) return null;
    setCreandoSala(true);
    try {
      const id = await createRoom();
      if (text) porMandar.current = { text };
      window.location.hash = `#/sala/${id}`;
      return id;
    } catch (e) {
      alert(t.noSePudoCrear + String(e));
      return null;
    } finally {
      setCreandoSala(false);
    }
  };

  /**
   * Suma imágenes a las que van a salir con el próximo mensaje.
   *
   * El tope de 4 no es capricho: cada imagen cuesta tokens y los paga quien
   * invoque al agente. Cortar aquí es más honesto que dejar mandar diez y que la
   * factura aparezca después.
   */
  const agregarImagenes = async (files: File[]) => {
    if (files.length === 0) return;
    // Los adjuntos suben a la sala (`POST /rooms/:id/adjuntos`), así que sin
    // sala hay que crearla primero. El id se usa de aquí en adelante y no de
    // `roomId`, que en esta pasada sigue valiendo null.
    const sala = roomId ?? (await nacerConMensaje(""));
    if (!sala) return;
    setErrorAdjunto(null);
    const sitio = MAX_ADJUNTOS - pendientes.length;
    if (sitio <= 0) {
      setErrorAdjunto(t.maxImagenes(MAX_ADJUNTOS));
      return;
    }
    if (files.length > sitio) setErrorAdjunto(t.maxImagenes(MAX_ADJUNTOS));

    // Cada archivo entra a la lista ANTES de subir, con su progreso, y se sube
    // en paralelo. Lo que impide mandar un id que todavía no existe es que
    // `send` mira si queda alguno con `subiendo`.
    for (const file of files.slice(0, sitio)) {
      const clave = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const esImagen = file.type.startsWith("image/");
      setPendientes((prev) => [
        ...prev,
        {
          clave,
          nombre: file.name || (esImagen ? "imagen" : "archivo"),
          mediaType: file.type,
          id: null,
          subiendo: 0,
          previewUrl: esImagen ? URL.createObjectURL(file) : undefined,
        },
      ]);

      void (async () => {
        try {
          const listo = await prepararParaSubir(file);
          const subido = await subirAdjunto(SERVER_URL, sala, listo, (pct) => {
            setPendientes((prev) =>
              prev.map((p) => (p.clave === clave ? { ...p, subiendo: pct } : p)),
            );
          });
          setPendientes((prev) =>
            prev.map((p) =>
              p.clave === clave ? { ...p, id: subido.id, subiendo: null } : p,
            ),
          );
        } catch (err) {
          // Fuera de la lista: un adjunto que no subió no puede salir en el
          // mensaje, y dejarlo ahí bloquearía el botón de enviar para siempre.
          setPendientes((prev) => prev.filter((p) => p.clave !== clave));
          setErrorAdjunto(err instanceof Error ? err.message : t.imagenNoSePudo);
        }
      })();
    }
  };

  /**
   * Alguno todavía no tiene id: mandar ahora dejaría el mensaje sin su archivo.
   *
   * Se mira el ID y no el progreso porque el id es la condición de verdad: es lo
   * único que el server puede resolver. El progreso es para enseñarlo.
   */
  const subiendoAlgo = pendientes.some((p) => !p.id);

  const send = () => {
    const text = draft.trim();
    // Mandar solo un archivo, sin escribir nada, es un mensaje legítimo.
    if (!text && pendientes.length === 0) return;
    if (subiendoAlgo) return;

    // Todavía no hay sala: este mensaje la crea. Sale solo cuando el server
    // conteste el `joined`, así que el borrador NO se limpia aquí: si la
    // creación falla, lo escrito sigue en la caja.
    if (!roomId) {
      void nacerConMensaje(text);
      return;
    }

    // Anclar MI selección local al mensaje (cuidado 2/3/4).
    socketRef.current?.emit("chat", {
      text,
      anchor: mySelection,
      // Solo los que ya subieron. `send` no llega aquí si falta alguno, pero
      // filtrar es más barato que confiar en que dos estados van a la par.
      adjuntos: pendientes.length
        ? pendientes
            .filter((p) => p.id)
            .map((p) => ({ id: p.id, nombre: p.nombre, mediaType: p.mediaType }))
        : undefined,
    });
    setDraft("");
    setPistaMencion(false);
    setPendientes([]);
    setMention(null);
    if (mySelection) {
      setMySelection(null);
      postToInspector({ type: "selection:clear" }); // cuidado 4
      setInspect(false);
    }
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

  /**
   * Copiar el link de la sala.
   *
   * Con aviso: copiar no se ve ni se oye, así que sin esto el botón no daba
   * ninguna señal de haber hecho algo y la gente le daba dos y tres veces. El
   * texto del botón ya existía en el i18n y no lo usaba nadie.
   */
  // El arrastre del divisor. Los listeners van en window y no en el divisor
  // porque el cursor se sale de él en cuanto te mueves rápido.
  useEffect(() => {
    const mover = (e: MouseEvent) => {
      if (!moviendoDivisor.current) return;
      // Topes para que ninguno de los dos desaparezca del todo.
      const ancho = Math.min(900, Math.max(280, e.clientX));
      setAnchoChat(ancho);
    };
    const soltar = () => {
      if (!moviendoDivisor.current) return;
      moviendoDivisor.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", mover);
    window.addEventListener("mouseup", soltar);
    return () => {
      window.removeEventListener("mousemove", mover);
      window.removeEventListener("mouseup", soltar);
    };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("multi.ancho-chat", String(anchoChat));
    } catch {
      // Modo incógnito: se pierde la preferencia, no la sala.
    }
  }, [anchoChat]);

  const copyLink = async () => {
    await navigator.clipboard.writeText(window.location.href);
    setCopiado(true);
  };

  // El aviso de copiado es de paso, no un estado en el que la barra se quede.
  useEffect(() => {
    if (!copiado) return;
    const id = setTimeout(() => setCopiado(false), 2000);
    return () => clearTimeout(id);
  }, [copiado]);

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

  /**
   * Crear una sala en blanco. El `+` de la cabecera.
   *
   * Lo que se llevara escrito se va con ella: el `+` es para empezar de nuevo,
   * y arrastrar el borrador a la sala nueva sería adivinar que eso era lo que
   * se quería. Enviar sí lo lleva, pero eso es otra cosa y la pide el enter.
   */
  const crearSala = () => {
    setDraft("");
    void nacerConMensaje("");
  };

  /**
   * Guardar el nombre nuevo de la sala.
   *
   * No se pinta aquí lo que quedó: se manda al server y se espera su
   * `room:renamed`, que llega igual para todos. Así el que renombra ve
   * exactamente lo mismo que sus compas, recortes y espacios incluidos.
   */
  /**
   * Cambia si hay que mencionar al agente en esta sala.
   *
   * No se pinta lo que quedó: se manda y se espera el `room:modo` del server,
   * igual que con el nombre. Es un ajuste de la sala y lo ven todos, así que la
   * fuente de verdad es una sola.
   */
  const cambiarModo = () => {
    socketRef.current?.emit("room:modo", { modo: modo === "solo" ? "multi" : "solo" });
  };

  const guardarNombre = (valor: string) => {
    setEditandoNombre(false);
    if (valor.trim() === (nombre ?? "")) return; // no cambió: nada que mandar
    socketRef.current?.emit("room:rename", { nombre: valor });
  };

  /**
   * Manda a la persona a autorizar en Supabase.
   *
   * Navegación completa y no fetch, igual que entrar con Google: el ida y
   * vuelta de OAuth pasa por el navegador, y al volver el server redirige de
   * regreso a esta misma sala.
   */
  const conectarSupabase = () => {
    if (!roomId) return;
    window.location.href = `${SERVER_URL}/rooms/${roomId}/supabase/conectar`;
  };

  const desconectarSupabase = async () => {
    if (!roomId) return;
    // El estado real llega por socket, que es lo que además avisa al resto de
    // la sala. Aquí solo se dispara.
    await fetch(`${SERVER_URL}/rooms/${roomId}/supabase`, { method: "DELETE" }).catch(() => {
      // Si no se pudo, la conexión sigue ahí y el panel la sigue mostrando.
    });
  };


  /**
   * Si la sala ya tiene algo que llevarse. Se consulta al entrar y cada vez que
   * aparece un punto nuevo en la línea de tiempo (`histVersion`), que es justo
   * cuando una sala vacía deja de estarlo.
   */
  useEffect(() => {
    // Sin sala no hay nada que preguntar: la URL salía con "null" dentro y el
    // server contestaba 404 en cada visita a la Sala vacía.
    if (!roomId) {
      setSePuedeExportar(false);
      return;
    }

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

  // Si esta sala ya tiene base, y si este Multi siquiera ofrece conectarla.
  useEffect(() => {
    if (!roomId) return;
    let cancelado = false;
    fetch(`${SERVER_URL}/rooms/${roomId}/supabase`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { configurado: boolean; proyecto: string | null } | null) => {
        if (!cancelado && d) setSupabase((s) => ({ ...s, ...d }));
      })
      .catch(() => {
        // Sin respuesta se queda sin configurar, que es el estado que no
        // promete nada. Peor sería enseñar un botón que no va a funcionar.
      });
    return () => {
      cancelado = true;
    };
  }, [roomId]);

  return (
    // `ver-*` es lo que el CSS usa en móvil para decidir qué se muestra. En
    // escritorio se ignora: ahí el chat y el preview conviven en dos columnas.
    <div className={`sala ver-${tab}`}>
      {/* Chat izquierda */}
      <aside className="chat" style={{ width: anchoChat }}>
        {/* Con mensajes ya en pantalla, el chat se ve normal aunque no llegue
            nada. Esta barra es lo único que distingue "nadie ha escrito" de
            "se cayó el wifi". */}
        {esperaLarga && messages.length > 0 && (
          <div className="chat-desconectado">{t.reconectando}</div>
        )}
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

        {/* El botón dice que se puede filtrar; los avatares de arriba son el
            atajo para quien ya lo sabe. Sin él, nada anuncia que existe. */}
        {roomId && (
          <FiltroChat
            gente={filtrables}
            filtro={filtro}
            onAlternar={alternarFiltro}
            onLimpiar={() => setFiltro(new Set())}
          />
        )}

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

        {/* Sin esto el chat filtrado se ve igual que un chat vacío, y no hay
            forma de saber que te estás perdiendo algo. */}
        {filtro.size > 0 && (
          <div className="filtro-aviso">
            <span>{t.mensajesOcultos(ocultos)}</span>
            <button type="button" onClick={() => setFiltro(new Set())}>
              {t.verTodo}
            </button>
          </div>
        )}

        <div className="chat-scroll">
          {/* Solo mientras no sabemos qué hay: en cuanto llega el `joined`, un
              chat vacío SÍ significa que nadie ha hablado. Y si ya hay mensajes
              pintados (una reconexión), taparlos sería peor que el vacío. */}
          {esperaLarga && messages.length === 0 && (
            <div className="chat-cargando">
              <div className="preview-barra" aria-hidden="true" />
              <p>{t.cargandoSala}</p>
            </div>
          )}
          {mensajesVisibles.map((m, i) => (
            // Mensajes seguidos del mismo autor se agrupan sin repetir avatar
            // ni nombre (patrón Discord): el chat respira y se lee como
            // conversación, no como lista de tarjetas.
            // Sin sala no hay mensajes que pintar, así que aquí siempre lo hay.
            //
            // `esSeguido` recibe el array YA FILTRADO a propósito: con el array
            // completo, dos mensajes que quedan contiguos tras filtrar se
            // pintarían como no-seguidos y repetirían avatar y nombre.
            <ChatRow key={i} msg={m} seguido={esSeguido(mensajesVisibles, i)} roomId={roomId!} />
          ))}
          {/* Un bloque de streaming POR AGENTE: varios pueden hablar a la vez */}
          {/* Los que trabajan entran aunque no hayan emitido NADA todavía.
              Escribir un archivo grande son cuarenta segundos en los que el
              modelo arma los argumentos de la herramienta y no hay nada que
              transmitir: sin esto el chat se ve idéntico a no haber mandado el
              mensaje, y la gente lo reenvía creyendo que se perdió. El estado
              ya viajaba, solo lo pintaba la lista de arriba. */}
          {Object.keys({ ...streaming, ...toolLines, ...trabajando })
            // El streaming NO sale de `messages`, así que sin esto un agente
            // filtrado fuera seguiría apareciendo mientras escribe y el filtro
            // se vería roto.
            .filter((agentId) => filtro.size === 0 || filtro.has(agentId))
            .map((agentId) => {
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
                  {/* Se va sola en cuanto llega el primer evento: su condición
                      deja de cumplirse y no hay nada que limpiar. Sin la tarea,
                      que ya se lee en el mensaje que la pidió. */}
                  {!toolLines[agentId]?.length && !streaming[agentId] && agent && (
                    <div className="agente-pensando">{textoDeEstado(agent, t, false)}</div>
                  )}
                </div>
              </div>
            );
          })}

          {/* Va aquí abajo y no en una barra arriba: la persona acaba de
              escribir y está mirando el final del chat, que es justo donde no
              pasó nada. Un aviso fuera de su campo de visión se lee igual que
              el silencio que viene a explicar. */}
          {pistaMencion && <div className="chat-pista">{t.pistaMencion}</div>}
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
              {pendientes.map((p) => (
                <div
                  className={`adjunto-chip ${p.subiendo !== null ? "subiendo" : ""}`}
                  key={p.clave}
                  title={p.nombre}
                >
                  {p.previewUrl ? (
                    <img src={p.previewUrl} alt={p.nombre} />
                  ) : (
                    // Un PDF no tiene miniatura: se enseña su nombre.
                    <span className="adjunto-doc">{p.nombre}</span>
                  )}
                  {p.subiendo !== null && (
                    <span className="adjunto-progreso" style={{ width: `${p.subiendo}%` }} />
                  )}
                  <span
                    className="adjunto-x"
                    onClick={() =>
                      setPendientes((prev) => prev.filter((q) => q.clave !== p.clave))
                    }
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
            {/* El textarea arriba y las acciones abajo, todo dentro de la
                misma caja. Antes el clip iba FUERA, a un lado, y el textarea
                era una franja de una línea: tenía borde el clip y no la caja
                de escribir, que es lo que alguien del experimento no encontró.
                Así la caja ocupa lo que merece y lo que se hace con ella vive
                dentro. */}
            <div className="caja-marco">
            <textarea
              ref={inputRef}
              className="caja"
              rows={1}
              placeholder={
                subiendoAlgo
                  ? t.subiendoArchivo
                  : roomId && modo
                    ? t.hablaConLaSala(modo)
                    : t.quieresConstruir
              }
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
                // Enter manda, Shift+Enter hace salto de línea. Es lo que hace
                // cualquier chat, y sin esto un textarea se traga el enter.
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
                if (e.key === "Escape") setMention(null);
              }}
            />
              <div className="caja-acciones">
                <button
              className="adjuntar-btn"
              onClick={() => fileInputRef.current?.click()}
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
                {/* Enviar también con botón: enter ya funcionaba, pero en el
                    teléfono no hay enter que mande, y quien llega de WhatsApp
                    busca la flecha antes que el teclado. */}
                <button
                  className="enviar-btn"
                  onClick={send}
                  disabled={(!draft.trim() && pendientes.length === 0) || subiendoAlgo}
                  title={t.enviar}
                  aria-label={t.enviar}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path
                      d="M12 19V5M5 12l7-7 7 7"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      </aside>

      {/* El divisor. Reemplaza al botón de ocultar el chat, que solo ofrecía
          todo o nada: aquí cada quien reparte el ancho como le sirva. */}
      <div
        className="divisor"
        role="separator"
        aria-orientation="vertical"
        aria-label={t.ajustarAncho}
        title={t.ajustarAncho}
        onMouseDown={() => {
          moviendoDivisor.current = true;
          // En el body y no en el divisor: mientras arrastras el cursor se sale
          // de él, y sin esto parpadea y se selecciona texto de la página.
          document.body.style.cursor = "col-resize";
          document.body.style.userSelect = "none";
        }}
      />

      {/* Escenario derecha */}
      <section className="escenario" ref={escenarioRef}>
        <div className="barra-sup">

          {/* Qué se está mirando del proyecto. Dos botones pegados y no dos
              sueltos: juntos se leen como un interruptor de una cosa, que es lo
              que son, y se ve cuál está puesto sin tener que compararlos.

              El del código todavía no lleva a ningún lado y por eso va
              apagado. Se pone ahora porque tres personas del experimento
              pidieron "ver o modificar el código", y sin el hueco en pantalla
              esa petición no tiene dónde aterrizar. */}
          <div className="switch-vista" role="group">
            <button className="switch-op activa" type="button">
              {t.vistaPreview}
            </button>
            <button className="switch-op" type="button" disabled title={t.vistaCodigoPronto}>
              {t.vistaCodigo}
            </button>
          </div>
          {/* Los mismos avatares que ya decían quién está, ahora también filtran
              el chat. Se reutilizan en vez de meter una fila de chips aparte:
              en una columna de 340px cada control nuevo se paga caro, y aquí el
              nombre y el color ya están en pantalla. */}
          <div className="presencia">
            {members.map((m) => (
              <button
                key={m.socketId}
                type="button"
                className={`filtro-btn ${filtro.has(m.name) ? "on" : ""} ${
                  filtro.size > 0 && !filtro.has(m.name) ? "off" : ""
                }`}
                style={filtro.has(m.name) ? { borderColor: m.color } : undefined}
                onClick={() => alternarFiltro(m.name)}
                title={filtro.has(m.name) ? t.quitarDelFiltro(m.name) : t.filtrarPor(m.name)}
              >
                <Avatar
                  foto={m.foto}
                  color={m.color}
                  inicial={m.name.slice(0, 1).toUpperCase()}
                />
              </button>
            ))}
            {/* Los agentes también filtran: en una sala con tres, saber cuál
                dijo qué es justo lo que se pierde en el ruido. */}
            {agents.map((a) => (
              <button
                key={a.id}
                type="button"
                className={`filtro-btn ${filtro.has(a.name) ? "on" : ""} ${
                  filtro.size > 0 && !filtro.has(a.name) ? "off" : ""
                }`}
                style={filtro.has(a.name) ? { borderColor: a.color } : undefined}
                onClick={() => alternarFiltro(a.name)}
                title={filtro.has(a.name) ? t.quitarDelFiltro(a.name) : t.filtrarPor(a.name)}
              >
                <Avatar color={a.color} inicial="AI" textoOscuro />
              </button>
            ))}
            <CuentaPanel
              usuario={cuenta.usuario}
              configurado={cuenta.configurado}
              onCambio={onCuentaCambio}
            />
            {/* La `key` cambia cuando el server pide la API key: remonta el
                panel para que se abra solo en ese momento. */}
            {/* Aquí vivían dos botones que se quitaron el mismo día, por la
                misma razón: pedían una decisión a quien solo quiere construir.

                El de la API key era de cuando cada persona traía la suya. Tenía
                sentido para un Multi que cualquiera hospeda, pero en el que
                está en línea la primera pantalla de alguien que llega era
                elegir un proveedor y pegar una credencial. Todo el camino sigue
                en pie (auth:key, el respaldo del .env, varios proveedores), así
                que volver a ofrecerlo es montar el panel otra vez.

                El de descargar .zip lo usaron cero personas de las 35 del
                experimento. Sacar la app de la sala ya se resuelve con
                Publicar, que da un enlace en vez de una carpeta que alguien
                tendría que saber correr. La ruta del server sigue ahí. */}
            {/* El modo sube aquí desde la cabecera del chat, donde competía por
                ancho con el nombre de la sala y quedaba apretado. */}
            {roomId && modo && (
              <button className="invitar" onClick={cambiarModo} title={t.modoAyuda(modo)}>
                {t.modo(modo)}
              </button>
            )}
            <PublicarPanel
              roomId={roomId}
              urlPublicada={urlPublicada}
              publicando={publicando}
              puedePublicar={sePuedeExportar}
              onPublicar={publicar}
            />
            {/* Las variables son del proyecto de la sala, así que sin sala no
                hay dónde escribirlas. */}
            {roomId && (
              <EnvPanel
                roomId={roomId}
                supabase={supabase}
                onConectarSupabase={conectarSupabase}
                onDesconectarSupabase={desconectarSupabase}
              />
            )}
            {/* Sin sala no hay link que compartir: copiaría la URL pelada. */}
            <button
              className={`invitar ${copiado ? "copiado" : ""}`}
              onClick={copyLink}
              disabled={!roomId}
            >
              {copiado ? t.copiado : t.copiarLink}
            </button>
          </div>
        </div>

        <div className="tabs">
          {/* Solo en pantallas chicas: ahí el chat no cabe al lado del preview,
              así que pasa a ser una pestaña más. En escritorio se esconde por
              CSS, porque ahí el chat vive en su columna y no es una vista. */}
          <button
            className={`tab tab-chat ${tab === "chat" ? "activa" : ""}`}
            onClick={() => setTab("chat")}
          >
            {t.elChat}
          </button>
          {/* "La app" ya no se pinta: al quitarse la pestaña del back quedaba
              sola, y una pestaña única no ofrece nada que elegir. La del chat
              sí se queda, que en móvil es la que cambia de vista. */}
        </div>

        {/* La pestaña del back se quitó: enseñaba un mapa de endpoints a gente
            que viene a hacer una presentación o una página, y era una decisión
            más en una pantalla que ya tenía de sobra. Lo que sí pidieron tres
            personas del experimento es VER EL CÓDIGO, y eso es otra cosa y va
            en otro lado. BackCanvas se queda en el repo para entonces. */}
        {/* Sin preview el marco sobra: encuadra un vacío, y lo que se lee como
            un cuadro grande y vacío parece que algo falló. Con contenido
            dentro sí separa las dos zonas, así que solo se quita mientras no
            hay nada que enmarcar. */}
        <div className={`lienzo ${previewReady ? "" : "sin-marco"}`}>
          {/* Señalar un elemento es una herramienta del preview, no una acción
              de la barra: ahí arriba se veía igual que "compartir" o
              "variables", que son otra cosa. Flotando encima de lo que señala
              se entiende sin leerlo. */}
          {roomId && previewReady && (
            <div className="herramientas-preview">
            <button
              className={`inspect-flotante ${inspect ? "on" : ""}`}
              onClick={() => setInspect((v) => !v)}
              title={t.tituloSelector}
              aria-label={t.tituloSelector}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M4 4l6.5 16 2.2-6.3 6.3-2.2L4 4z"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinejoin="round"
                />
              </svg>
              <span>{inspect ? t.seleccionando : t.seleccionarBtn}</span>
            </button>
            {/* A qué ancho se ve el preview. Baja aquí desde la barra de
                pestañas, que en escritorio existía solo para sostenerlo y
                robaba altura justo a lo que todos miran. */}
            <button
              className="vista-btn flotante"
              onClick={() => setVista(VISTAS[(VISTAS.indexOf(vista) + 1) % VISTAS.length])}
              title={t.verEn[vista]}
              aria-label={t.verEn[vista]}
            >
              <IconoDeVista vista={vista} />
            </button>
            {/* El historial, detrás de un icono. Antes vivía siempre abierto
                debajo del preview, y eso son unos cincuenta píxeles de alto
                para algo que se consulta de vez en cuando. */}
            <button
              className={`vista-btn flotante ${histAbierto ? "on" : ""}`}
              onClick={() => setHistAbierto((v) => !v)}
              title={t.tituloHistorial}
              aria-label={t.tituloHistorial}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M12 8v4l3 2M3 12a9 9 0 1 0 2.6-6.4M3 4v4h4"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            </div>
          )}
          {previewReady ? (
            <>
              {/* El ancho va en el marco, no en el iframe, y el iframe NUNCA se
                  desmonta: recargarlo perdería el estado de la app (formularios
                  a medias, en qué pantalla ibas) y costaría segundos. */}
              <div className="preview-marco" style={{ maxWidth: ANCHO_DE_VISTA[vista] }}>
                {/* Mientras el navegador trae el HTML del proyecto, el iframe se
                    ve en blanco. La barra es lo único que distingue "cargando"
                    de "se rompió". */}
                {cargandoFrame && <div className="preview-barra" aria-hidden="true" />}
                <iframe
                  ref={iframeRef}
                  className="preview-frame"
                  src={previewSrc}
                  title={t.tituloPreview}
                  onLoad={() => setCargandoFrame(false)}
                />
              </div>
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
                  <p className="preview-titulo">{t.levantandoPreview}</p>
                  <p className="preview-loading-sub">{t.etapaPreview[arrancando]}</p>
                </>
              ) : !roomId ? (
                // Todavía no hay sala, y eso ya no es un impedimento: la crea
                // el primer mensaje. Así que aquí no se anuncia una carencia,
                // se dice qué hacer.
                <>
                  <p className="preview-titulo">{t.quieresConstruir}</p>
                  <p className="preview-loading-sub">
                    {t.porEjemplo} <code>{t.ejemploSinJerga}</code>
                  </p>
                </>
              ) : esperaLarga ? (
                // Hay sala, pero su estado todavía no llega. Decir aquí que está
                // vacía sería inventar: no se sabe.
                <>
                  <div className="preview-spinner" aria-hidden="true" />
                  <p className="preview-titulo">{t.cargandoSala}</p>
                </>
              ) : (
                <>
                  <p className="preview-titulo">{t.salaVacia}</p>
                  {/* Sin saber el modo no se dice nada: enseñar la arroba a
                      quien no la necesita es peor que esperar medio segundo. */}
                  {modo && <Ejemplos modo={modo} />}
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

        {/* La línea de tiempo de la sala. Solo cuando se pide: vivía siempre
            abierta bajo el preview y le comía altura a lo que todos miran. */}
        {roomId && histAbierto && (
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
/**
 * El icono del botón: dice a qué ancho se está viendo ahora.
 *
 * Van dibujados y no como emoji para que se vean igual en todos lados, y para
 * que hereden el color del botón como el resto de la interfaz.
 */
function IconoDeVista({ vista }: { vista: Vista }) {
  // Un rectángulo por cada clase de pantalla, con sus proporciones: el monitor
  // ancho, la tablet casi cuadrada, el teléfono alto y angosto.
  const caja =
    vista === "escritorio"
      ? { x: 2, y: 4, w: 20, h: 14, r: 2 }
      : vista === "tablet"
        ? { x: 5, y: 3, w: 14, h: 18, r: 2 }
        : { x: 7, y: 2, w: 10, h: 20, r: 2 };

  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect
        x={caja.x}
        y={caja.y}
        width={caja.w}
        height={caja.h}
        rx={caja.r}
        stroke="currentColor"
        strokeWidth="1.8"
      />
      {/* El pie del monitor, que es lo que lo distingue de una tablet apaisada. */}
      {vista === "escritorio" && (
        <path d="M9 21h6M12 18v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      )}
      {/* El botón del teléfono, por lo mismo. */}
      {vista === "movil" && (
        <path d="M11 19h2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      )}
    </svg>
  );
}

/**
 * El color con el que el server marca un mensaje de sistema que ES un fallo.
 *
 * Los mensajes de sistema no son todos iguales: "entró agente-1 a la sala" es
 * ruido, y "agente-2: se acabó el crédito" es algo que si no ves, te quedas
 * esperando sin saber por qué nada pasa. El server ya los separa por color al
 * emitirlos, así que el filtro se apoya en eso en vez de leer el texto.
 */
const COLOR_FALLO = "#d95d63";

/** ¿Este mensaje se ve con el filtro puesto? */
function pasaElFiltro(msg: ChatMessage, filtro: Set<string>): boolean {
  if (filtro.size === 0) return true;
  // Los fallos se ven siempre: perderse uno deja a alguien esperando a un agente
  // que ya se murió.
  if (msg.role === "system") return msg.color === COLOR_FALLO;
  return filtro.has(msg.from);
}

function esSeguido(msgs: ChatMessage[], i: number): boolean {
  if (i === 0) return false;
  const prev = msgs[i - 1];
  const m = msgs[i];
  if (m.role === "system" || prev.role === "system") return false;
  if (m.anchoredTo) return false;
  return prev.from === m.from && prev.role === m.role;
}

/**
 * La carita de alguien: su foto si tiene cuenta, y si no la inicial de siempre.
 *
 * Está extraído porque el mismo círculo se pinta en la presencia de arriba y en
 * cada mensaje, y hasta ahora el markup estaba copiado en los dos sitios.
 *
 * El `onError` es el único fallback callado de por aquí, y se justifica: si la
 * foto de Google no carga (sin red, cuenta borrada), la inicial es exactamente
 * lo que se veía antes. Gritarlo en el chat no le serviría a nadie.
 */
function Avatar(props: {
  foto?: string | null;
  color: string;
  inicial: string;
  titulo?: string;
  textoOscuro?: boolean;
}) {
  const [fallo, setFallo] = useState(false);
  // La foto puede ser una URL de Google o una que subió la persona a este
  // server; `urlDeFoto` resuelve las dos.
  const src = urlDeFoto(props.foto);
  if (src && !fallo) {
    return (
      <img
        className="av"
        src={src}
        alt=""
        title={props.titulo}
        referrerPolicy="no-referrer"
        onError={() => setFallo(true)}
      />
    );
  }
  return (
    <div
      className="av"
      style={{ background: props.color, color: props.textoOscuro ? "#3d2a12" : "#fff" }}
      title={props.titulo}
    >
      {props.inicial}
    </div>
  );
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
          className={esPdf(a) ? "adjunto-doc-link" : undefined}
        >
          {/* Un PDF no se puede mirar en miniatura: se enseña su nombre y se
              abre en el visor del navegador al darle click. */}
          {esPdf(a) ? (
            a.nombre
          ) : (
            <img src={`${SERVER_URL}/rooms/${roomId}/adjuntos/${a.id}`} alt={a.nombre} />
          )}
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
        <Avatar
          foto={msg.role === "agent" ? null : msg.foto}
          color={msg.color}
          inicial={msg.role === "agent" ? "AI" : initial}
          titulo={msg.from}
          textoOscuro={msg.role === "agent"}
        />
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
