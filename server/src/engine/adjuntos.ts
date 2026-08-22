import { writeFile, mkdir, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Las imágenes que la gente pega en el chat.
 *
 * Viven JUNTO al workspace, no dentro, igual que los turnos y los marcadores del
 * historial. La razón es la misma en los tres casos: lo que la sala necesita para
 * funcionar no tiene por qué acabar en el repo que alguien se va a descargar.
 *
 * Una imagen puede ser dos cosas muy distintas. Puede ser plática ("miren esto
 * está cabrón"), y entonces no pinta nada dentro del proyecto. O puede ser
 * material de trabajo ("pon este logo en el header"), y entonces sí. Guardarlas
 * todas dentro convertiría el repo en el carrete de la sala.
 *
 * La que sí se va a usar entra al proyecto cuando el AGENTE lo decide, con la
 * tool `usar_adjunto`. Es él quien sabe dónde van los estáticos de su stack:
 * public/ en Vite y Next, src/assets/ en Astro. El motor no lo impone, igual que
 * no impone el stack.
 */

export interface Adjunto {
  /** Nombre en disco. Es lo que viaja al front y lo que el agente referencia. */
  id: string;
  /** Cómo se llamaba el archivo de quien lo subió. Solo para mostrarlo. */
  nombre: string;
  mediaType: string;
  bytes: number;
}

/**
 * Los formatos que los modelos con visión aceptan. Las dos documentaciones
 * oficiales coinciden en la lista (agosto de 2026).
 */
export const TIPOS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

/**
 * Techo por imagen, ya decodificada.
 *
 * Anthropic acepta hasta 10MB, pero eso no es la restricción que importa: una
 * imagen grande cuesta más tokens y aquí paga cada quien con su propia key. El
 * navegador ya las reduce a 1568px antes de mandarlas (ver web/src/imagenes.ts),
 * así que 2MB es techo de seguridad, no el caso normal.
 */
const MAX_BYTES = 2 * 1024 * 1024;

/** Cuántas caben en un mensaje. Más que esto y el turno se vuelve caro sin avisar. */
export const MAX_POR_MENSAJE = 4;

/** El directorio de adjuntos de una sala, hermano de su workspace. */
export function adjuntosDir(workspaceDir: string): string {
  return join(dirname(workspaceDir), `${basenameOf(workspaceDir)}.adjuntos`);
}

function basenameOf(p: string): string {
  return p.split(/[/\\]/).filter(Boolean).pop() ?? "sala";
}

/**
 * Deja el nombre en algo que se puede escribir en disco sin sustos.
 *
 * El nombre lo pone quien sube el archivo, así que llega con lo que sea: barras,
 * `..`, caracteres raros de otro sistema operativo. Aquí no se sanea "por si
 * acaso": el id que se usa para escribir se genera aparte (ver `guardarAdjunto`),
 * y este nombre es solo para enseñarlo en el chat.
 */
function nombreVisible(nombre: unknown): string {
  if (typeof nombre !== "string" || !nombre.trim()) return "imagen";
  return nombre.replace(/[/\\]/g, "_").slice(0, 80);
}

export class AdjuntoInvalido extends Error {}

/**
 * Guarda una imagen del chat y devuelve con qué referirse a ella.
 *
 * El id NO deriva del nombre que mandó la persona. Se genera aquí, y lleva solo
 * la extensión que corresponde al mediaType declarado. Así ningún nombre de
 * archivo de fuera decide dónde se escribe: es la misma idea que `safePath` en
 * las tools, resuelta antes de que haya una ruta que validar.
 */
export async function guardarAdjunto(
  workspaceDir: string,
  entrada: { nombre?: unknown; mediaType?: unknown; data?: unknown },
): Promise<Adjunto> {
  const mediaType = typeof entrada.mediaType === "string" ? entrada.mediaType : "";
  const ext = TIPOS[mediaType];
  if (!ext) {
    throw new AdjuntoInvalido(
      `formato no soportado: ${mediaType || "(ninguno)"}. Solo PNG, JPEG, WebP y GIF.`,
    );
  }

  if (typeof entrada.data !== "string" || !entrada.data) {
    throw new AdjuntoInvalido("la imagen llegó vacía");
  }

  const buf = Buffer.from(entrada.data, "base64");
  if (buf.length === 0) {
    throw new AdjuntoInvalido("la imagen no es base64 válido");
  }
  if (buf.length > MAX_BYTES) {
    const mb = (buf.length / 1024 / 1024).toFixed(1);
    throw new AdjuntoInvalido(`la imagen pesa ${mb}MB y el tope son 2MB`);
  }

  // El nombre visible va DENTRO del id, después del uuid, para poder buscar por
  // él sin llevar un índice aparte. El uuid delante es lo que garantiza que dos
  // capturas llamadas igual no se pisen, y que el nombre de fuera no decida nada.
  const nombre = nombreVisible(entrada.nombre);
  const id = `${randomUUID()}__${sanearParaDisco(nombre, ext)}`;
  const dir = adjuntosDir(workspaceDir);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, id), buf);

  return { id, nombre, mediaType, bytes: buf.length };
}

/**
 * El nombre reducido a lo que se puede escribir en cualquier sistema de archivos,
 * con la extensión que corresponde al tipo declarado (no a la que traía el
 * nombre: alguien puede subir un PNG llamado "foto.jpg").
 */
function sanearParaDisco(nombre: string, ext: string): string {
  const base = nombre
    .replace(/\.[^.]*$/, "")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .slice(0, 40)
    .replace(/^[-.]+/, "");
  return `${base || "imagen"}${ext}`;
}

/** El nombre con el que se subió, sacado del id. Para buscar por él. */
export function nombreDe(id: string): string {
  const sep = id.indexOf("__");
  return sep === -1 ? id : id.slice(sep + 2);
}

/**
 * Lee un adjunto en base64, para armar el bloque `image` del mensaje al modelo.
 *
 * El id se comprueba contra lo que hay en el directorio en vez de confiar en su
 * forma. Un id que no está en la lista no existe, sin importar cómo venga
 * escrito.
 */
export async function leerAdjunto(
  workspaceDir: string,
  id: string,
): Promise<{ data: string; mediaType: string } | null> {
  const dir = adjuntosDir(workspaceDir);
  if (!existsSync(dir)) return null;

  const hay = await readdir(dir);
  if (!hay.includes(id)) return null;

  const mediaType = mediaTypeDe(id);
  if (!mediaType) return null;

  const buf = await readFile(join(dir, id));
  return { data: buf.toString("base64"), mediaType };
}

/** Ruta absoluta de un adjunto, o null si no existe. Para servirlo y para copiarlo. */
export async function rutaAdjunto(workspaceDir: string, id: string): Promise<string | null> {
  const dir = adjuntosDir(workspaceDir);
  if (!existsSync(dir)) return null;
  const hay = await readdir(dir);
  return hay.includes(id) ? join(dir, id) : null;
}

/** Los adjuntos que existen en la sala, para que el agente pueda buscarlos por nombre. */
export async function listarAdjuntos(workspaceDir: string): Promise<string[]> {
  const dir = adjuntosDir(workspaceDir);
  if (!existsSync(dir)) return [];
  return (await readdir(dir)).filter((f) => mediaTypeDe(f) !== null);
}

/** El mediaType que corresponde a la extensión de un id ya guardado. */
export function mediaTypeDe(id: string): string | null {
  const ext = extname(id).toLowerCase();
  const par = Object.entries(TIPOS).find(([, e]) => e === ext);
  return par ? par[0] : null;
}
