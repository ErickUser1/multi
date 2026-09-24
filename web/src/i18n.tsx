import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

/**
 * Los textos de la Sala, en los dos idiomas.
 *
 * El CÓDIGO sigue en español y así se queda: los nombres, los comentarios y los
 * mensajes de commit. Lo que se traduce es lo que ve quien entra, que puede no
 * hablar español.
 *
 * Los dos idiomas van juntos en el mismo archivo a propósito. Si alguien cambia
 * una frase en uno y no en el otro, se ve al instante porque están una debajo de
 * la otra; repartidos en dos archivos, la versión vieja sobrevive meses.
 */

export type Idioma = "es" | "en";

const CLAVE = "multi.idioma";

/** Arranca con el idioma del navegador y recuerda lo que elijas. */
function idiomaInicial(): Idioma {
  let guardado: string | null = null;
  try {
    guardado = localStorage.getItem(CLAVE);
  } catch {
    // Con el storage bloqueado, leerlo lanza. Esto corre antes que todo lo
    // demás: si lanzara aquí, la página entera se quedaría en blanco.
  }
  if (guardado === "es" || guardado === "en") return guardado;
  return navigator.language.toLowerCase().startsWith("es") ? "es" : "en";
}

const TEXTOS = {
  es: {
    // Entrada
    tuNombre: "¿cómo te llamas?",
    creandoSala: "creando sala…",
    entrar: "Entrar",
    vasAEntrar: "vas a entrar a la sala",
    noSePudoCrear: "no se pudo crear la sala: ",
    anonimo: "anónimo",

    // Sala
    enLaSala: (n: number) => `${n} en la sala`,
    // El nombre del modo, no lo que hace. Se probó al revés ("sin @" / "con @")
    // y no le dice nada a quien todavía no sabe qué significa la arroba, que es
    // justo a quien esto viene a ayudar. Qué implica cada uno lo cuenta el
    // texto de abajo, al pasar el cursor.
    modo: (m: "solo" | "multi"): string => (m === "solo" ? "Solo" : "Multijugador"),
    modoAyuda: (m: "solo" | "multi"): string =>
      m === "solo"
        ? "Escribir despierta al agente. Toca para pedir que haya que mencionarlo, y poder platicar sin gastar tokens."
        : "Hay que escribir @agente para despertarlo. Toca para que responda a todo lo que escribas.",
    renombrarSala: "clic para ponerle nombre",
    ningunaSala: "ninguna sala abierta",
    /**
     * El preview cuando todavía no hay nada, con o sin sala.
     *
     * Es el mismo texto en los dos casos a propósito: es la misma pantalla y el
     * mismo momento, y que cambiara al mandar el primer mensaje se leía como
     * haber llegado a otro lado.
     *
     * Antes decía "ninguna sala abierta, crea una con el +" y "la sala está
     * vacía". Las dos describían lo que falta; esta dice qué hacer, que es lo
     * que hacía falta desde que escribir es lo que crea la sala.
     */
    quieresConstruir: "¿Qué quieres construir?",
    /**
     * El preview mientras el agente arma lo primero.
     *
     * Dice "la primera versión" y no "tu petición" porque la sala es de varios
     * y lo pudo pedir alguien más, y porque nombra algo que se va a ver
     * aparecer. Solo sale una vez en la vida de la sala: después ya hay preview
     * y lo que avisa es la barra de arriba.
     */
    armandoPrimera: "El agente está armando la primera versión",
    falloArmando: "Algo falló al armar la versión",
    falloArmandoNota:
      "Pídele al agente en el chat que lo revise, o cuéntale qué querías y lo intenta de otra forma.",
    armandoNota:
      "Cuando esté lista aparece aquí. Mientras tanto pueden seguir pidiendo cosas en el chat.",
    cargandoSala: "Cargando la sala…",
    reconectando: "Sin conexión. Reconectando…",
    /* Lo que la sala vacía y la caja de escribir dicen cambia con el modo.
     *
     * En "solo" no se menciona la arroba: ahí escribir YA despierta al agente,
     * y pedirla es enseñar un paso que no existe. Pasó en vivo con la primera
     * persona de fuera de la escuela que abrió Multi: la pantalla le hablaba
     * de "stack" y de "@agente", y acabó preguntando si tenía que mandar un
     * archivo antes de escribir.
     *
     * Y el ejemplo es de lo que alguien quiere, no de con qué se construye.
     * Quien llega no sabe qué es Next ni Tailwind, y no le hace falta. */
    hablaConLaSala: (m: "solo" | "multi"): string =>
      m === "solo" ? "escribe lo que quieres construir" : "escribe @agente para pedir algo",
    /**
     * Lo que se puede pedir, rotando. Es la sala vacía enseñando de qué va.
     *
     * Tres de los cuatro primeros usuarios que llegaron solos vinieron a hacer
     * presentaciones, no apps, y la pantalla solo hablaba de páginas: quien no
     * lo sabía de antemano no tenía cómo enterarse. Por eso el primero es una
     * presentación y no una landing.
     *
     * Van sin jerga a propósito, que es lo mismo que se aprendió del
     * experimento: nadie sabe qué es un stack, y no le hace falta.
     */
    ejemplos: [
      "una presentación para mi clase",
      "un juego sencillo",
      "una app para mi negocio",
      "una página para mi evento",
      "una calculadora de gastos",
    ],
    construyeAlgoComo: "Construye algo como",
    adjuntarImagen: "Adjuntar un archivo",
    enviar: "Enviar",
    agentesInactivos: (n: number) => `${n} agente${n === 1 ? "" : "s"} inactivo${n === 1 ? "" : "s"}`,
    seInterrumpio: (n: number) =>
      n === 1 ? "Un agente se interrumpió" : `${n} agentes se interrumpieron`,
    aMediaTarea: "a media tarea. ¿Guardas lo que alcanzó a hacer?",
    guardarTrabajo: "Guardar",
    volverAlPunto: "Volver al último punto",
    seleccionando: "seleccionando…",
    seleccionarBtn: "Seleccionar elemento",
    vistaPreview: "Vista previa",
    vistaCodigo: "Código",
    vistaCodigoPronto: "Todavía no se puede ver el código desde aquí",
    copiarLink: "Compartir",
    copiado: "Copiado",
    // Los textos del .zip se quedan aunque su botón ya no se monte: la ruta del
    // server sigue en pie, así que volver a ofrecerlo es poner el botón y nada
    // más. Borrarlos obligaría a reescribirlos en los dos idiomas.
    descargarZip: "Descargar .zip",
    publicar: "Publicar",
    publicarTitulo: "Poner la app en internet, con un link para compartir",
    etapaDeploy: {
      compilando: "Compilando…",
      subiendo: "Subiendo…",
    } as Record<string, string>,
    publicarFallo: "no se pudo publicar",
    enVivo: "En vivo",
    republicar: "Publicar los cambios",
    publicadaTitulo: "Publicada",
    sinPublicarTitulo: "Sin publicar",
    publicarNota:
      "Publicar pone la app en internet, con un link que puedes pasarle a quien sea. Nadie tiene que entrar a Multi para verla.",
    publicarNotaViva:
      "Lo que cambies aquí no se ve afuera hasta que vuelvas a publicar.",
    preparandoZip: "Preparando…",
    zipSalaVacia: "todavía no hay nada que descargar",
    zipTrabajoSinGuardar: "hay trabajo sin guardar, el .zip lleva el último punto guardado",
    zipFallo: "no se pudo preparar el .zip",
    ponerMiKey: "poner mi key",

    // Cuenta (opcional: se entra a las salas sin ella)
    entrarConGoogle: "Entrar con Google",
    miPerfil: "Mi perfil",
    cambiarFoto: "Cambiar foto",
    fotoFormato: "Solo PNG, JPEG, WebP o GIF.",
    cuentaNota:
      "Con cuenta tus salas te siguen a cualquier dispositivo, y tu nombre y tu foto son los mismos en todas. Sin cuenta se entra igual, como siempre.",
    miCuenta: "Mi cuenta",
    cerrarSesion: "Salir",
    salasGuardadas: "Tus salas se guardan en tu cuenta.",

    // Variables del proyecto (.env)
    envBoton: "Variables",
    envTitulo: "Variables del proyecto",
    envNota:
      "Van al .env de esta sala: la app y el agente las leen. Son de la sala, así que las ve quien entre. Las que la app lee desde el navegador necesitan el prefijo de su framework (VITE_, NEXT_PUBLIC_); sin él no llegan a la app publicada.",
    envVacio: "Todavía no hay ninguna.",
    envNombre: "NOMBRE",
    envValor: "valor",
    envAgregar: "Agregar",
    envQuitar: "Quitar",
    envVer: "Ver el valor",
    envOcultar: "Ocultar el valor",
    envGuardando: "Guardando…",
    envGuardado: "Guardado",
    envReinicio: "Reinicia el proyecto para que las tome (pídeselo al agente).",
    envNoSePudo: "no se pudieron guardar: ",
    sbTitulo: "Base de datos",
    sbNota:
      "Conecta Supabase y la sala tendrá su base, con las variables puestas solas. El proyecto queda en tu cuenta de Supabase, no en Multi.",
    sbConectar: "Conectar Supabase",
    sbCreando: "Creando el proyecto…",
    sbLevantando: "Levantando la base, esto tarda unos minutos…",
    sbProtegiendo: "Dejándola protegida…",
    sbConectado: (proyecto: string) => `Conectada al proyecto ${proyecto}.`,
    sbPendiente: (proyecto: string) =>
      `El proyecto ${proyecto} existe, pero sus variables no llegaron al .env y el agente no lo ve.`,
    sbTerminar: "Terminar de conectar",
    sbDesconectar: "Desconectar",
    sbPassword:
      "Esta es la contraseña de tu base. Cópiala ahora: Supabase no la vuelve a mostrar y Multi no la va a enseñar otra vez.",
    seleccionarElemento: "Seleccionar elemento",
    selecciono: "seleccionó",
    contraer: "contraer",

    // Presentar
    ocultarChat: "Ocultar el chat",
    ajustarAncho: "Arrastra para ajustar el ancho",
    tituloHistorial: "Versiones del proyecto",

    // Filtro del chat
    filtrarChat: "Filtrar",
    filtrandoA: (n: number) => (n === 1 ? "Filtrando a 1" : `Filtrando a ${n}`),
    tagAgente: "agente",
    // Estado de un agente. Los usan la lista de arriba y el bloque del chat: el
    // mismo hecho no debe leerse distinto en dos lugares de la misma pantalla.
    estadoTrabajando: "trabajando",
    estadoEsperandoA: (quien: string, ruta: string) => `esperando a ${quien} (${ruta})`,
    estadoEsperando: "esperando",
    otroAgente: "otro agente",
    estadoAtorado: "atorado, sin avanzar",
    estadoInactivo: "inactivo",
    filtrarPor: (quien: string) => `Ver solo lo de ${quien}`,
    quitarDelFiltro: (quien: string) => `Quitar a ${quien} del filtro`,
    mensajesOcultos: (n: number) =>
      n === 1 ? "1 mensaje oculto" : `${n} mensajes ocultos`,
    verTodo: "Ver todo",
    mostrarChat: "Mostrar el chat",

    // Imágenes
    quitarImagen: "quitar",
    subiendoArchivo: "subiendo…",
    maxImagenes: (n: number) => `caben ${n} archivos por mensaje`,
    imagenNoSePudo: "no se pudo preparar el archivo",

    // Pestañas
    /** Pestaña del chat: solo se ve en pantallas chicas. */
    elChat: "El chat",
    laApp: "La app",
    /** Qué se ve ahora, en el botón que cicla los anchos del preview. */
    verEn: {
      escritorio: "Viendo en computadora — clic para tablet",
      tablet: "Viendo en tablet — clic para celular",
      movil: "Viendo en celular — clic para computadora",
    } as Record<string, string>,
    elBack: "El back",

    // Preview
    tituloPreview: "preview de la app",
    tituloSelector: "selecciona un elemento del preview",
    tituloEstadoActual: "el estado actual",

    // Lo que el agente va haciendo, en la línea de actividad del chat
    actLeer: (archivo: string) => `Leyendo ${archivo}`,
    actEscribir: (archivo: string) => `Escribiendo ${archivo}`,
    actEditar: (archivo: string) => `Editando ${archivo}`,
    actBuscarArchivos: "Buscando archivos",
    actBuscarTexto: "Buscando en el código",
    actBaseDeDatos: "Cambiando la base de datos",
    actAdjunto: "Usando un archivo adjunto",
    actCrearProyecto: "Creando el proyecto",
    actInstalar: "Instalando dependencias",
    actCompilar: "Revisando que la app compile",
    actGit: "Guardando la versión",
    actHistorial: "Revisando el historial",
    actConexion: "Probando una conexión",
    actMover: "Moviendo archivos",
    actRevisar: "Revisando archivos",
    actComando: "Ejecutando un comando",
    enviandoAlReconectar: "Sin conexión: se envía en cuanto vuelva",

    // Back visual
    leyendoProyecto: "leyendo el proyecto…",
    sinBack: "Todavía no hay nada del lado del servidor.",
    viveEn: "vive en",
    sinImplementacion: "sin implementación en el proyecto",
    loLlama: "lo llama",
    nadieLoLlama: "nadie lo llama desde el front",

    // Arranque del preview
    levantandoPreview: "Levantando la app…",
    etapaPreview: {
      contenedor: "Preparando el entorno de la sala.",
      dependencias: "Instalando dependencias. Esta es la parte lenta.",
      servidor: "Arrancando el servidor de desarrollo.",
    } as Record<string, string>,

    // Menú de salas
    tusSalas: "Tus salas",
    sinOtrasSalas: "Todavía no has entrado a otra sala.",
    crearOtraSala: "Crear otra sala",
    quitarDeLaLista: "Quitar de la lista",
    borrarSala: "Borrar la sala",
    // Se nombra la sala y se dice que es para todos: borrarla se lleva el
    // trabajo de quien estuviera ahí, no solo tu acceso.
    confirmarBorrarSala: (id: string) =>
      `¿Borrar la sala ${id}? Se va el proyecto y el chat, para ti y para todos los que entren con el link. No se puede deshacer.`,
    noSePudoBorrar: "no se pudo borrar la sala: ",
    salaBorrada: "Alguien borró esta sala. El proyecto y el chat ya no existen.",
    salaBorradaOk: (id: string) => `Se borró ${id}.`,

    // Historial
    historial: "Historial",
    sinCambios: "aún no hay cambios guardados",
    ahora: "Ahora",
    volverAqui: "Volver aquí",
    regresarAqui: "Regresar aquí",
    regresarSolo: (f: string) => `regresar solo ${f}`,
    confirmarArchivo: (f: string) => `¿Regresar solo ${f} a este estado?`,
    confirmarTodo: "¿Regresar TODO el proyecto a este estado?",
    confirmarNota: "No se borra nada: se guarda como un cambio nuevo y lo posterior sigue en el historial.",
    confirmarDatos: "El código vuelve, pero los datos de la base NO.",
    siRegresar: "Sí, regresar",
    cancelar: "Cancelar",
    comoLaLlamas: "¿cómo la llamas?",
    versionQueFuncionaba: "versión que funcionaba",

    // Back visual (mensajes largos)
    backVacioNota: "Cuando el front llame a una API o el agente cree un endpoint, aparece aquí.",
    faltantes: (n: number) =>
      n === 1
        ? "1 endpoint que el front llama todavía no existe"
        : `${n} endpoints que el front llama todavía no existen`,
    epEstado: {
      faltante: "el front lo llama, pero no existe todavía",
      conectado: "existe y el front lo usa",
      huerfano: "existe, pero nadie lo llama",
    },

    // Panel de credencial
    tuModelo: "Tu modelo",
    proveedor: "Proveedor",
    key: "Key",
    modelo: "Modelo",
    guardar: "Guardar",
    ollamaSinKey: "cualquier cosa: Ollama no pide key",
    delUsuario: "del usuario",
    cambiar: "Cambiar",
    keyGuardadaNota:
      "Guardado en este navegador: sirve en todas tus salas y sigue aquí mañana. Nadie más en la sala lo ve.",
    /** Aclaración corta junto al nombre del proveedor. Solo donde aporta algo. */
    proveedorNota: {
      anthropic: "Claude",
      openrouter: "muchos modelos",
      groq: "rápido",
      ollama: "en tu máquina",
    } as Record<string, string | undefined>,
    keyNecesaria: "necesaria para invocar agentes",
    keyListo: "listo",
    cerrar: "cerrar",
    keyNota: "Cada quien usa el suyo: lo que le pidas al agente lo pagas tú, no la sala.",
    dondeSacoKey: (proveedor: string) => `¿De dónde saco una key de ${proveedor}?`,
    gratis: "gratis",
    olvidar: "olvidar",

    // Menciones
    loDetiene: "lo detiene",
    yNoUn: " y no un ",

  },

  en: {
    // Entrada
    tuNombre: "what's your name?",
    creandoSala: "creating room…",
    entrar: "Join",
    vasAEntrar: "you're joining room",
    noSePudoCrear: "couldn't create the room: ",
    anonimo: "anonymous",

    // Sala
    enLaSala: (n: number) => `${n} in the room`,
    modo: (m: "solo" | "multi"): string => (m === "solo" ? "Solo" : "Multiplayer"),
    modoAyuda: (m: "solo" | "multi"): string =>
      m === "solo"
        ? "Anything you write wakes the agent. Tap to require mentioning it, so you can chat without spending tokens."
        : "You need to write @agente to wake it. Tap to make it answer everything you write.",
    renombrarSala: "click to name it",
    ningunaSala: "no room open",
    quieresConstruir: "What do you want to build?",
    armandoPrimera: "The agent is building the first version",
    falloArmando: "Something failed while building the version",
    falloArmandoNota:
      "Ask the agent in the chat to take a look, or tell it what you wanted and it will try another way.",
    armandoNota:
      "It shows up here when it is ready. Meanwhile you can keep asking for things in the chat.",
    cargandoSala: "Loading the room…",
    reconectando: "No connection. Reconnecting…",
    hablaConLaSala: (m: "solo" | "multi"): string =>
      m === "solo" ? "type what you want to build" : "type @agente to ask for something",
    ejemplos: [
      "a deck for my class",
      "a simple game",
      "an app for my business",
      "a page for my event",
      "an expense calculator",
    ],
    construyeAlgoComo: "Build something like",
    adjuntarImagen: "Attach a file",
    enviar: "Send",
    agentesInactivos: (n: number) => `${n} idle agent${n === 1 ? "" : "s"}`,
    seInterrumpio: (n: number) =>
      n === 1 ? "An agent was interrupted" : `${n} agents were interrupted`,
    aMediaTarea: "mid-task. Keep what it got done?",
    guardarTrabajo: "Keep",
    volverAlPunto: "Go back to the last point",
    seleccionando: "selecting…",
    seleccionarBtn: "Select element",
    vistaPreview: "Preview",
    vistaCodigo: "Code",
    vistaCodigoPronto: "You can't view the code from here yet",
    copiarLink: "Share",
    copiado: "Copied",
    descargarZip: "Download .zip",
    publicar: "Publish",
    publicarTitulo: "Put the app online, with a link you can share",
    etapaDeploy: {
      compilando: "Building…",
      subiendo: "Uploading…",
    } as Record<string, string>,
    publicarFallo: "couldn't publish it",
    enVivo: "Live",
    republicar: "Publish changes",
    publicadaTitulo: "Published",
    sinPublicarTitulo: "Not published",
    publicarNota:
      "Publishing puts the app online, with a link you can send to anyone. They don't need to join Multi to see it.",
    publicarNotaViva: "What you change here isn't live until you publish again.",
    preparandoZip: "Preparing…",
    zipSalaVacia: "nothing to download yet",
    zipTrabajoSinGuardar: "there's unsaved work, the .zip has the last saved point",
    zipFallo: "couldn't prepare the .zip",
    ponerMiKey: "add my key",

    // Cuenta (opcional: se entra a las salas sin ella)
    entrarConGoogle: "Sign in with Google",
    miPerfil: "My profile",
    cambiarFoto: "Change picture",
    fotoFormato: "PNG, JPEG, WebP or GIF only.",
    cuentaNota:
      "With an account your rooms follow you to any device, and your name and picture are the same everywhere. Without one you still get in, same as always.",
    miCuenta: "My account",
    cerrarSesion: "Sign out",
    salasGuardadas: "Your rooms are saved to your account.",

    // Variables del proyecto (.env)
    envBoton: "Variables",
    envTitulo: "Project variables",
    envNota:
      "They go in this room's .env: the app and the agent read them. They belong to the room, so anyone who joins can see them. The ones the app reads from the browser need its framework's prefix (VITE_, NEXT_PUBLIC_); without it they never reach the published app.",
    envVacio: "None yet.",
    envNombre: "NAME",
    envValor: "value",
    envAgregar: "Add",
    envQuitar: "Remove",
    envVer: "Show value",
    envOcultar: "Hide value",
    envGuardando: "Saving…",
    envGuardado: "Saved",
    envReinicio: "Restart the project so it picks them up (ask the agent).",
    envNoSePudo: "couldn't save them: ",
    sbTitulo: "Database",
    sbNota:
      "Connect Supabase and the room gets its own database, with the variables filled in for you. The project lives in your Supabase account, not in Multi.",
    sbConectar: "Connect Supabase",
    sbCreando: "Creating the project…",
    sbLevantando: "Bringing the database up, this takes a few minutes…",
    sbProtegiendo: "Locking it down…",
    sbConectado: (proyecto: string) => `Connected to project ${proyecto}.`,
    sbPendiente: (proyecto: string) =>
      `Project ${proyecto} exists, but its variables never reached the .env, so the agent can't see it.`,
    sbTerminar: "Finish connecting",
    sbDesconectar: "Disconnect",
    sbPassword:
      "This is your database password. Copy it now: Supabase never shows it again, and neither will Multi.",
    seleccionarElemento: "Select element",
    selecciono: "selected",
    contraer: "collapse",

    // Presentar
    ocultarChat: "Hide the chat",
    ajustarAncho: "Drag to resize",
    tituloHistorial: "Project versions",

    // Chat filter
    filtrarChat: "Filter",
    filtrandoA: (n: number) => (n === 1 ? "Filtering 1" : `Filtering ${n}`),
    tagAgente: "agent",
    estadoTrabajando: "working",
    estadoEsperandoA: (quien: string, ruta: string) => `waiting for ${quien} (${ruta})`,
    estadoEsperando: "waiting",
    otroAgente: "another agent",
    estadoAtorado: "stuck, not moving",
    estadoInactivo: "idle",
    filtrarPor: (quien: string) => `Show only ${quien}`,
    quitarDelFiltro: (quien: string) => `Remove ${quien} from the filter`,
    mensajesOcultos: (n: number) => (n === 1 ? "1 message hidden" : `${n} messages hidden`),
    verTodo: "Show all",
    mostrarChat: "Show the chat",

    // Imágenes
    quitarImagen: "remove",
    subiendoArchivo: "uploading…",
    maxImagenes: (n: number) => `${n} files per message max`,
    imagenNoSePudo: "couldn’t prepare the file",

    // Pestañas
    elChat: "Chat",
    laApp: "The app",
    verEn: {
      escritorio: "Desktop view — click for tablet",
      tablet: "Tablet view — click for mobile",
      movil: "Mobile view — click for desktop",
    } as Record<string, string>,
    elBack: "The back",

    // Preview
    tituloPreview: "app preview",
    tituloSelector: "select an element from the preview",
    tituloEstadoActual: "current state",

    // What the agent is doing, in the chat's activity line
    actLeer: (archivo: string) => `Reading ${archivo}`,
    actEscribir: (archivo: string) => `Writing ${archivo}`,
    actEditar: (archivo: string) => `Editing ${archivo}`,
    actBuscarArchivos: "Looking for files",
    actBuscarTexto: "Searching the code",
    actBaseDeDatos: "Changing the database",
    actAdjunto: "Using an attached file",
    actCrearProyecto: "Creating the project",
    actInstalar: "Installing dependencies",
    actCompilar: "Checking that the app builds",
    actGit: "Saving the version",
    actHistorial: "Looking at the history",
    actConexion: "Testing a connection",
    actMover: "Moving files",
    actRevisar: "Looking through files",
    actComando: "Running a command",
    enviandoAlReconectar: "Offline: it will be sent as soon as you're back",

    // Back visual
    leyendoProyecto: "reading the project…",
    sinBack: "Nothing on the server side yet.",
    viveEn: "lives in",
    sinImplementacion: "not implemented in the project",
    loLlama: "calls it",
    nadieLoLlama: "nothing calls it from the front end",

    // Arranque del preview
    levantandoPreview: "Starting the app…",
    etapaPreview: {
      contenedor: "Preparing the room's environment.",
      dependencias: "Installing dependencies. This is the slow part.",
      servidor: "Starting the dev server.",
    } as Record<string, string>,

    // Menú de salas
    tusSalas: "Your rooms",
    sinOtrasSalas: "You haven't joined another room yet.",
    crearOtraSala: "Create another room",
    quitarDeLaLista: "Remove from the list",
    borrarSala: "Delete the room",
    confirmarBorrarSala: (id: string) =>
      `Delete room ${id}? The project and the chat are gone, for you and for anyone with the link. This can't be undone.`,
    noSePudoBorrar: "couldn't delete the room: ",
    salaBorrada: "Someone deleted this room. The project and the chat are gone.",
    salaBorradaOk: (id: string) => `${id} deleted.`,

    // Historial
    historial: "History",
    sinCambios: "no saved changes yet",
    ahora: "Now",
    volverAqui: "Go back here",
    regresarAqui: "Go back here",
    regresarSolo: (f: string) => `revert only ${f}`,
    confirmarArchivo: (f: string) => `Revert only ${f} to this state?`,
    confirmarTodo: "Revert the WHOLE project to this state?",
    confirmarNota: "Nothing gets deleted: it's saved as a new change and everything after stays in the history.",
    confirmarDatos: "The code comes back, but the database data does NOT.",
    siRegresar: "Yes, revert",
    cancelar: "Cancel",
    comoLaLlamas: "what do you call it?",
    versionQueFuncionaba: "version that worked",

    // Back visual (mensajes largos)
    backVacioNota: "When the front end calls an API or the agent creates an endpoint, it shows up here.",
    faltantes: (n: number) =>
      n === 1
        ? "1 endpoint the front end calls doesn't exist yet"
        : `${n} endpoints the front end calls don't exist yet`,
    epEstado: {
      faltante: "the front end calls it, but it doesn't exist yet",
      conectado: "exists and the front end uses it",
      huerfano: "exists, but nothing calls it",
    },

    // Panel de credencial
    tuModelo: "Your model",
    proveedor: "Provider",
    key: "Key",
    modelo: "Model",
    guardar: "Save",
    ollamaSinKey: "anything: Ollama doesn't ask for a key",
    delUsuario: "from",
    cambiar: "Change",
    keyGuardadaNota:
      "Saved in this browser: works in all your rooms and it's still here tomorrow. Nobody else in the room sees it.",
    /** Aclaración corta junto al nombre del proveedor. Solo donde aporta algo. */
    proveedorNota: {
      anthropic: "Claude",
      openrouter: "many models",
      groq: "fast",
      ollama: "on your machine",
    } as Record<string, string | undefined>,
    keyNecesaria: "needed to spawn agents",
    keyListo: "ready",
    cerrar: "close",
    keyNota: "Everyone uses their own: whatever you ask the agent for, you pay, not the room.",
    dondeSacoKey: (proveedor: string) => `Where do I get a ${proveedor} key?`,
    gratis: "free",
    olvidar: "forget",

    // Menciones
    loDetiene: "stops it",
    yNoUn: " and not a ",

  },
};

/**
 * El contrato de textos sale del español. El inglés se comprueba contra él, así
 * que si alguien agrega una frase en uno y olvida el otro, no compila.
 */
export type Textos = (typeof TEXTOS)["es"];

// Comprobación en tiempo de compilación: los dos idiomas tienen las mismas claves.
const _completo: Record<Idioma, Textos> = TEXTOS;
void _completo;

const Ctx = createContext<{ t: Textos; idioma: Idioma }>({
  t: TEXTOS.es,
  idioma: "es",
});

export function IdiomaProvider({ children }: { children: ReactNode }) {
  const [idioma] = useState<Idioma>(idiomaInicial);

  useEffect(() => {
    try {
      localStorage.setItem(CLAVE, idioma);
    } catch {
      // Se pierde la preferencia, no la página.
    }
    document.documentElement.lang = idioma;
  }, [idioma]);

  return (
    <Ctx.Provider value={{ t: TEXTOS[idioma], idioma }}>{children}</Ctx.Provider>
  );
}

/** Los textos del idioma activo. */
export function useTextos() {
  return useContext(Ctx);
}
