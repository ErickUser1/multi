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
  const guardado = localStorage.getItem(CLAVE);
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
    renombrarSala: "clic para ponerle nombre",
    ningunaSala: "ninguna sala abierta",
    eligeOCrea: "abre una de tus salas o crea una nueva con el +",
    salaVacia: "La sala está vacía.",
    pideAlgo: "@agente crea un Next con Tailwind",
    hablaConLaSala: "habla con la sala — o escribe @agente para pedir algo",
    adjuntarImagen: "Adjuntar una imagen",
    agentesInactivos: (n: number) => `${n} agente${n === 1 ? "" : "s"} inactivo${n === 1 ? "" : "s"}`,
    seInterrumpio: (n: number) =>
      n === 1 ? "Un agente se interrumpió" : `${n} agentes se interrumpieron`,
    aMediaTarea: "a media tarea. ¿Guardas lo que alcanzó a hacer?",
    guardarTrabajo: "Guardar",
    volverAlPunto: "Volver al último punto",
    seleccionando: "seleccionando…",
    seleccionarBtn: "Seleccionar elemento",
    porEjemplo: "Por ejemplo:",
    copiarLink: "Copiar link",
    copiado: "Copiado",
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

    // Variables del proyecto (.env)
    envBoton: "Variables",
    envTitulo: "Variables del proyecto",
    envNota:
      "Van al .env de esta sala: la app y el agente las leen. Son de la sala, así que las ve quien entre.",
    envVacio: "Todavía no hay ninguna.",
    envNombre: "NOMBRE",
    envValor: "valor",
    envAgregar: "Agregar",
    envQuitar: "Quitar",
    envGuardando: "Guardando…",
    envGuardado: "Guardado",
    envReinicio: "Reinicia el proyecto para que las tome (pídeselo al agente).",
    envNoSePudo: "no se pudieron guardar: ",
    seleccionarElemento: "Seleccionar elemento",
    selecciono: "seleccionó",
    contraer: "contraer",

    // Presentar
    ocultarChat: "Ocultar el chat",
    mostrarChat: "Mostrar el chat",

    // Imágenes
    quitarImagen: "quitar",
    maxImagenes: (n: number) => `caben ${n} imágenes por mensaje`,
    imagenNoSePudo: "no se pudo preparar la imagen",

    // Pestañas
    laApp: "La app",
    elBack: "El back",

    // Preview
    tituloPreview: "preview de la app",
    tituloSelector: "selecciona un elemento del preview",
    tituloEstadoActual: "el estado actual",

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
    pideleAlAgente: "Pídele a un agente que arranque el proyecto, el stack lo eliges tú.",
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
    renombrarSala: "click to name it",
    ningunaSala: "no room open",
    eligeOCrea: "open one of your rooms or create a new one with the +",
    salaVacia: "The room is empty.",
    pideAlgo: "@agente build a Next app with Tailwind",
    hablaConLaSala: "talk to the room — or type @agente to ask for something",
    adjuntarImagen: "Attach an image",
    agentesInactivos: (n: number) => `${n} idle agent${n === 1 ? "" : "s"}`,
    seInterrumpio: (n: number) =>
      n === 1 ? "An agent was interrupted" : `${n} agents were interrupted`,
    aMediaTarea: "mid-task. Keep what it got done?",
    guardarTrabajo: "Keep",
    volverAlPunto: "Go back to the last point",
    seleccionando: "selecting…",
    seleccionarBtn: "Select element",
    porEjemplo: "For example:",
    copiarLink: "Copy link",
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

    // Variables del proyecto (.env)
    envBoton: "Variables",
    envTitulo: "Project variables",
    envNota:
      "They go in this room's .env: the app and the agent read them. They belong to the room, so anyone who joins can see them.",
    envVacio: "None yet.",
    envNombre: "NAME",
    envValor: "value",
    envAgregar: "Add",
    envQuitar: "Remove",
    envGuardando: "Saving…",
    envGuardado: "Saved",
    envReinicio: "Restart the project so it picks them up (ask the agent).",
    envNoSePudo: "couldn't save them: ",
    seleccionarElemento: "Select element",
    selecciono: "selected",
    contraer: "collapse",

    // Presentar
    ocultarChat: "Hide the chat",
    mostrarChat: "Show the chat",

    // Imágenes
    quitarImagen: "remove",
    maxImagenes: (n: number) => `${n} images per message max`,
    imagenNoSePudo: "couldn't prepare the image",

    // Pestañas
    laApp: "The app",
    elBack: "The back",

    // Preview
    tituloPreview: "app preview",
    tituloSelector: "select an element from the preview",
    tituloEstadoActual: "current state",

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
    pideleAlAgente: "Ask an agent to start the project, you pick the stack.",
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
    localStorage.setItem(CLAVE, idioma);
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
