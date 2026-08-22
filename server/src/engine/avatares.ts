import { mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { TIPOS } from "./adjuntos.js";
import { WORKSPACES_ROOT } from "./workspace.js";

/**
 * Las fotos de perfil de quien tiene cuenta.
 *
 * Van aparte de los adjuntos del chat y no colgando de una sala, porque una foto
 * de perfil es de la persona y se ve en TODAS las salas donde entra. El camino de
 * los adjuntos valida que el archivo pertenezca a la sala que lo pide, que es
 * justo la garantía que aquí estorba.
 *
 * Lo que sí se reusa es la tabla de formatos: si algún día se acepta uno nuevo,
 * se acepta en los dos sitios sin que uno se quede atrás.
 */

/** Tope por foto. Más bajo que el de los adjuntos a propósito. */
const MAX_BYTES = 512 * 1024;

export class AvatarInvalido extends Error {}

/**
 * Dónde viven. Junto a los workspaces y con punto delante, que es lo que ya
 * está gitignorado, para que no acaben en ningún commit ni en un .zip.
 */
export function avataresDir(): string {
  return join(WORKSPACES_ROOT, ".avatares");
}

/**
 * Guarda la foto y devuelve su id.
 *
 * El id lleva un uuid nuevo CADA VEZ, incluso si es la misma persona cambiando
 * su foto. Eso es lo que hace honesto el `immutable` con el que se sirve: el
 * contenido de un id nunca cambia, y cambiar de foto es cambiar de id. Si se
 * reusara el id, la foto vieja se quedaría pegada un año en el navegador de
 * todos los que la hubieran visto.
 */
export async function guardarAvatar(entrada: {
  mediaType?: unknown;
  data?: unknown;
}): Promise<string> {
  const mediaType = typeof entrada.mediaType === "string" ? entrada.mediaType : "";
  const ext = TIPOS[mediaType];
  if (!ext) {
    throw new AvatarInvalido(
      `formato no soportado: ${mediaType || "(ninguno)"}. Solo PNG, JPEG, WebP y GIF.`,
    );
  }
  if (typeof entrada.data !== "string" || !entrada.data) {
    throw new AvatarInvalido("la imagen llegó vacía");
  }

  const buf = Buffer.from(entrada.data, "base64");
  if (buf.length === 0) throw new AvatarInvalido("la imagen no es base64 válido");
  if (buf.length > MAX_BYTES) {
    const kb = Math.round(buf.length / 1024);
    throw new AvatarInvalido(`la imagen pesa ${kb}KB y el tope son 512KB`);
  }

  const id = `${randomUUID()}${ext}`;
  const dir = avataresDir();
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, id), buf);
  return id;
}

/**
 * La ruta en disco de una foto, o null si no está.
 *
 * Se comprueba listando el directorio y no armando la ruta con lo que pidieron:
 * así un id con `..` o con barras no puede sacar a nadie de aquí. Mismo criterio
 * que los adjuntos.
 */
export async function rutaAvatar(id: string): Promise<string | null> {
  try {
    const dir = avataresDir();
    const hay = await readdir(dir);
    return hay.includes(id) ? join(dir, id) : null;
  } catch {
    return null;
  }
}

/** El tipo de una foto, deducido de su extensión. */
export function mediaTypeDeAvatar(id: string): string | null {
  for (const [tipo, ext] of Object.entries(TIPOS)) {
    if (id.endsWith(ext)) return tipo;
  }
  return null;
}

/**
 * Borra una foto que ya no usa nadie.
 *
 * Se llama al cambiar de foto, con la anterior. Un fallo aquí no se propaga: que
 * quede un archivo suelto de 200KB es mucho menos grave que impedirle a alguien
 * cambiar su foto.
 */
export async function borrarAvatar(id: string): Promise<void> {
  const ruta = await rutaAvatar(id);
  if (ruta) await rm(ruta, { force: true }).catch(() => {});
}

/** Si esta foto la guardamos aquí (y no es una URL de Google). */
export function esAvatarPropio(foto: string | null | undefined): boolean {
  return !!foto && !foto.startsWith("http");
}
