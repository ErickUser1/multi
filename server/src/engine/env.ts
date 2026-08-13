import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Las variables de entorno del proyecto de una sala: su `.env`.
 *
 * Es lo que el proyecto necesita para conectarse a algo de fuera: la base de
 * datos que trajo alguien, la key de un proveedor si la app usa IA, un token de
 * pagos. Multi no las interpreta ni sabe qué significan; solo las escribe donde
 * el proyecto las va a buscar.
 *
 * Van a un archivo y no a la base de Multi porque el proyecto las lee de ahí en
 * tiempo de ejecución: cualquier stack sabe leer un `.env`, y el agente también,
 * así que no hay que enseñarle nada nuevo.
 *
 * Son de la SALA, no de quien las puso: todos los que entren trabajan contra la
 * misma base. El `.gitignore` del motor ya excluye `.env`, así que no entran a
 * los commits ni viajan en el .zip.
 */

/** Solo lo que un shell acepta como nombre de variable. */
const NOMBRE_VALIDO = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Tope por valor. Una credencial larga cabe de sobra; un archivo pegado, no. */
const MAX_VALOR = 4000;

/** Cuántas caben. Más que esto y ya no es configuración, es otra cosa. */
const MAX_VARIABLES = 50;

export interface Variable {
  nombre: string;
  valor: string;
}

function rutaEnv(workspaceDir: string): string {
  return join(workspaceDir, ".env");
}

/**
 * Lee las variables del `.env` de la sala.
 *
 * Formato mínimo a propósito: `NOMBRE=valor`, una por línea. Se ignoran los
 * comentarios y las líneas que no parezcan una asignación, para no romperse con
 * un archivo que el agente haya escrito a su manera.
 */
export async function leerVariables(workspaceDir: string): Promise<Variable[]> {
  const ruta = rutaEnv(workspaceDir);
  if (!existsSync(ruta)) return [];

  const texto = await readFile(ruta, "utf8").catch(() => "");
  const vars: Variable[] = [];
  for (const linea of texto.split("\n")) {
    const limpia = linea.trim();
    if (!limpia || limpia.startsWith("#")) continue;
    const igual = limpia.indexOf("=");
    if (igual <= 0) continue;
    const nombre = limpia.slice(0, igual).trim();
    if (!NOMBRE_VALIDO.test(nombre)) continue;
    // Las comillas son del formato, no del valor: se quitan al leer y se
    // vuelven a poner al escribir.
    const valor = limpia.slice(igual + 1).trim().replace(/^["']|["']$/g, "");
    vars.push({ nombre, valor });
  }
  return vars;
}

/**
 * Escribe la lista completa de variables, pisando el `.env` anterior.
 *
 * Se escribe entero y no línea por línea porque el panel manda siempre la lista
 * completa: lo que se ve ahí es lo que queda. Así borrar una variable es no
 * mandarla, sin necesitar una operación aparte.
 */
export async function guardarVariables(
  workspaceDir: string,
  crudas: unknown,
): Promise<Variable[]> {
  const lista = Array.isArray(crudas) ? crudas : [];
  const vistos = new Set<string>();
  const vars: Variable[] = [];

  for (const v of lista) {
    if (vars.length >= MAX_VARIABLES) break;
    const nombre = typeof (v as Variable)?.nombre === "string" ? (v as Variable).nombre.trim() : "";
    const valor = typeof (v as Variable)?.valor === "string" ? (v as Variable).valor : "";
    // Un nombre inválido rompería el archivo para todas las demás, así que se
    // descarta en vez de escribirlo y dejar el `.env` sin poder leerse.
    if (!NOMBRE_VALIDO.test(nombre) || vistos.has(nombre)) continue;
    vistos.add(nombre);
    // Los saltos de línea partirían la asignación en dos y la segunda mitad
    // quedaría suelta en el archivo.
    vars.push({ nombre, valor: valor.replace(/[\r\n]/g, " ").slice(0, MAX_VALOR) });
  }

  const cabecera = [
    "# Las variables del proyecto de esta sala.",
    "# Las escribe Multi desde el panel de la barra de arriba; se pueden editar",
    "# aquí también, pero el panel las vuelve a escribir cuando alguien lo use.",
    "",
  ];
  const cuerpo = vars.map((v) => `${v.nombre}="${v.valor}"`);
  await writeFile(rutaEnv(workspaceDir), [...cabecera, ...cuerpo, ""].join("\n"), "utf8");
  return vars;
}
