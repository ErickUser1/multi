import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { open, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

const execFileP = promisify(execFile);

/**
 * Ver el código de la sala, de solo lectura.
 *
 * Lo que se enseña es lo que git considera el proyecto: lo commiteado más lo
 * nuevo que no esté ignorado. Así quedan fuera, sin listas propias que
 * mantener, `node_modules`, `dist` y sobre todo el `.env`, que Multi ya
 * excluye en `.git/info/exclude` (ver `ensureGitignore` en workspace.ts).
 */

/** Más que esto no es un proyecto que alguien vaya a recorrer a mano. */
const MAX_ARCHIVOS = 2000;
/** Un archivo más grande que esto no se lee en un visor, y pesaría en el socket. */
export const MAX_BYTES_ARCHIVO = 300 * 1024;

export async function archivosDelProyecto(dir: string): Promise<string[]> {
  const { stdout } = await execFileP(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: dir, maxBuffer: 16 * 1024 * 1024 },
  ).catch(() => ({ stdout: "" }));
  const rutas = [...new Set(stdout.split("\0").filter(Boolean))];
  rutas.sort((a, b) => a.localeCompare(b));
  return rutas.slice(0, MAX_ARCHIVOS);
}

export type ArchivoDelProyecto =
  | { ruta: string; contenido: string; tamano: number }
  | { ruta: string; binario: true }
  | { ruta: string; grande: true; tamano: number };

/**
 * Lee un archivo del proyecto, o null si esa ruta no es parte de él.
 *
 * La única ruta que se acepta es una que `archivosDelProyecto` lista en este
 * momento. Eso cierra de una vez el `../`, las rutas absolutas y los archivos
 * ignorados como el `.env`: no hace falta adivinar cada truco, porque lo que
 * no está en la lista no existe para este visor. Lo de resolver la ruta y ver
 * que quede adentro es una segunda cerradura por si git devolviera algo raro.
 */
export async function leerArchivoDelProyecto(
  dir: string,
  ruta: string,
): Promise<ArchivoDelProyecto | null> {
  const lista = await archivosDelProyecto(dir);
  if (!lista.includes(ruta)) return null;

  const raiz = resolve(dir);
  const absoluta = resolve(raiz, ruta);
  if (!absoluta.startsWith(raiz + sep)) return null;

  let info;
  try {
    info = await stat(absoluta);
  } catch {
    // Listado pero ya no está: el agente lo acaba de borrar.
    return null;
  }
  if (!info.isFile()) return null;
  if (info.size > MAX_BYTES_ARCHIVO) return { ruta, grande: true, tamano: info.size };

  const fh = await open(absoluta, "r");
  try {
    const { buffer, bytesRead } = await fh.read({ buffer: Buffer.alloc(info.size), position: 0 });
    const bytes = buffer.subarray(0, bytesRead);
    // Un byte NUL al principio es la señal clásica de binario (imágenes, el
    // doc.yjs del documento). Mostrarlo como texto solo pintaría basura.
    if (bytes.subarray(0, 8192).includes(0)) return { ruta, binario: true };
    return { ruta, contenido: bytes.toString("utf8"), tamano: bytes.length };
  } finally {
    await fh.close();
  }
}
