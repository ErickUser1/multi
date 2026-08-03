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
    tagline: "un lugar para vibecodear con tus compas",
    tuNombre: "¿cómo te llamas?",
    crearSala: "Crear una sala",
    creandoSala: "creando sala…",
    pegaLink: "pega el link o el nombre de la sala",
    entrar: "Entrar",
    oEntraConLink: "o entra con el link que te pasó tu compa",
    vasAEntrar: "vas a entrar a la sala",
    noEncontreSala: "no encontré el nombre de la sala ahí",
    noSePudoCrear: "no se pudo crear la sala: ",
    anonimo: "anónimo",

    // Sala
    enLaSala: (n: number) => `${n} en la sala`,
    salaVacia: "La sala está vacía.",
    pideAlgo: "@agente crea un Next con Tailwind",
    hablaConLaSala: "habla con la sala — o escribe @agente para pedir algo",
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
    ponerMiKey: "poner mi key",
    seleccionarElemento: "Seleccionar elemento",
    selecciono: "seleccionó",
    contraer: "contraer",

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
    tagline: "a place to vibe code with your friends",
    tuNombre: "what's your name?",
    crearSala: "Create a room",
    creandoSala: "creating room…",
    pegaLink: "paste the link or the room name",
    entrar: "Join",
    oEntraConLink: "or join with the link a friend sent you",
    vasAEntrar: "you're joining room",
    noEncontreSala: "couldn't find a room name in there",
    noSePudoCrear: "couldn't create the room: ",
    anonimo: "anonymous",

    // Sala
    enLaSala: (n: number) => `${n} in the room`,
    salaVacia: "The room is empty.",
    pideAlgo: "@agente build a Next app with Tailwind",
    hablaConLaSala: "talk to the room — or type @agente to ask for something",
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
    ponerMiKey: "add my key",
    seleccionarElemento: "Select element",
    selecciono: "selected",
    contraer: "collapse",

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
