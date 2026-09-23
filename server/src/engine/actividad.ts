/**
 * Lo que el agente está haciendo, dicho como lo diría una persona.
 *
 * La línea de actividad del chat mostraba la tool tal cual: `write_file →
 * src/App.jsx`, `glob **\/*`, `$ cd /work && mv .env /tmp/.env.bak && npm
 * create…`. Quien usa Multi muchas veces no programa, y para esa persona eso es
 * ruido que además da miedo. Aquí se decide QUÉ acción es; la frase la arma la
 * Sala con sus textos, para que salga en el idioma de quien la está viendo.
 *
 * El detalle crudo (el comando, el patrón, la ruta) viaja también: la Sala lo
 * enseña al pasar el mouse, que es donde lo busca quien sí programa.
 */

export type TipoDeAccion =
  | "leer"
  | "escribir"
  | "editar"
  | "buscarArchivos"
  | "buscarTexto"
  | "baseDeDatos"
  | "adjunto"
  | "crearProyecto"
  | "instalar"
  | "compilar"
  | "git"
  | "conexion"
  | "mover"
  | "revisar"
  | "comando"
  | "otra";

export interface Accion {
  tipo: TipoDeAccion;
  /** El nombre del archivo, sin carpetas, cuando la acción es sobre uno. */
  archivo?: string;
  /** Lo que la tool recibió tal cual, para quien quiera verlo. */
  detalle?: string;
}

export function accionDeTool(nombre: string, input: Record<string, unknown>): Accion {
  const texto = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  switch (nombre) {
    case "read_file":
      return { tipo: "leer", archivo: base(texto("path")), detalle: texto("path") };
    case "write_file":
      return { tipo: "escribir", archivo: base(texto("path")), detalle: texto("path") };
    case "edit_file":
      return { tipo: "editar", archivo: base(texto("path")), detalle: texto("path") };
    case "glob":
      return { tipo: "buscarArchivos", detalle: texto("pattern") };
    case "grep":
      return { tipo: "buscarTexto", detalle: texto("pattern") };
    case "sql":
      return { tipo: "baseDeDatos", detalle: texto("descripcion") };
    case "usar_adjunto":
      return { tipo: "adjunto", detalle: texto("destino") || undefined };
    case "bash":
      return { tipo: accionDeComando(texto("command")), detalle: texto("command") };
    default:
      return { tipo: "otra", detalle: nombre };
  }
}

/**
 * Qué hace un comando de shell, a grandes rasgos.
 *
 * Un comando del agente suele ser una cadena (`cd /work && npm install && npm
 * run build`), así que se mira cada pedazo y gana el más significativo: de una
 * cadena que instala y luego lista archivos, lo que importa es que instaló. El
 * orden de abajo es esa prioridad.
 */
export function accionDeComando(comando: string): TipoDeAccion {
  const pedazos = comando
    .split(/&&|\|\||;|\|/)
    .map((p) => p.trim().replace(/^(sudo|env\s+\S+=\S+)\s+/, ""))
    .filter((p) => p && !/^cd\b/.test(p));

  const hay = (re: RegExp) => pedazos.some((p) => re.test(p));
  if (hay(CREAR_PROYECTO)) return "crearProyecto";
  if (hay(INSTALAR)) return "instalar";
  if (hay(COMPILAR)) return "compilar";
  if (hay(/^git\b/)) return "git";
  if (hay(/^(curl|wget)\b/)) return "conexion";
  if (hay(/^(mv|cp|mkdir|rm|rmdir|touch|chmod|ln)\b/)) return "mover";
  if (hay(REVISAR)) return "revisar";
  return "comando";
}

const CREAR_PROYECTO =
  /^((npm|pnpm|yarn|bun)\s+(create|init)\b|npx\s+(-y\s+)?(create-|sv\s+create|nuxi\s+init)|django-admin\s+startproject|cargo\s+(new|init)|go\s+mod\s+init|rails\s+new)/;

const INSTALAR =
  /^((npm|pnpm|bun)\s+(i|install|ci|add)\b|yarn(\s+(add|install))?\s*$|yarn\s+add\b|pip3?\s+install|uv\s+(add|pip\s+install|sync)|poetry\s+(add|install)|go\s+get|cargo\s+add|npx\s+(-y\s+)?playwright\s+install)/;

const COMPILAR =
  /^((npm|pnpm|yarn|bun)\s+(run\s+)?(build|lint|test|typecheck|check)\b|npx\s+(tsc|vite\s+build|eslint|oxlint)|tsc\b|vite\s+build|cargo\s+(build|check|test)|go\s+(build|vet|test)|pytest|python3?\s+-m\s+(pytest|compileall))/;

const REVISAR =
  /^(ls|pwd|cat|head|tail|find|grep|rg|wc|tree|stat|file|ps|date|which|echo|printenv|env|du|df|node\s+-v|npm\s+-v|node\s+--version)\b/;

function base(ruta: string): string {
  return ruta.split("/").filter(Boolean).pop() ?? ruta;
}
