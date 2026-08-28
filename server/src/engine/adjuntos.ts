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
 * Lo que se puede adjuntar, con su extensión y su firma.
 *
 * La FIRMA son los primeros bytes del archivo, y se comprueba en vez de creerle
 * al tipo que declara quien sube: eso lo pone el navegador y se puede cambiar.
 * Sin esto, un ejecutable renombrado a .pdf se guarda, se le sirve al resto de
 * la sala, y alguien lo abre confiando en la extensión.
 *
 * Los formatos de imagen son los que los modelos con visión aceptan (las dos
 * documentaciones oficiales coinciden). El PDF lo lee el modelo directo, sin
 * que nadie tenga que extraerle el texto.
 */
interface Formato {
  ext: string;
  /** Los primeros bytes que tiene que traer. En hex para poder leerlos. */
  firma: string;
  /** Techo por archivo, ya decodificado. */
  maxBytes: number;
}

/**
 * Techo de las imágenes.
 *
 * Anthropic acepta hasta 10MB, pero eso no es la restricción que importa: una
 * imagen grande cuesta más tokens y aquí paga cada quien con su propia key. El
 * navegador ya las reduce a 1568px antes de mandarlas (ver web/src/imagenes.ts),
 * así que 2MB es techo de seguridad, no el caso normal.
 */
const MAX_IMAGEN = 2 * 1024 * 1024;

/**
 * Techo de los PDFs: el mismo que acepta la API de Anthropic.
 *
 * Más alto que el de las imágenes porque un PDF no se puede reducir antes de
 * mandarlo. Pero ojo con lo que de verdad cuesta: el precio lo pone el CONTEXTO,
 * no el peso. Un PDF de texto denso de 5MB gasta más tokens que uno de 20MB
 * lleno de páginas escaneadas.
 */
const MAX_PDF = 32 * 1024 * 1024;

const FORMATOS: Record<string, Formato> = {
  "image/png": { ext: ".png", firma: "89504e47", maxBytes: MAX_IMAGEN },
  "image/jpeg": { ext: ".jpg", firma: "ffd8ff", maxBytes: MAX_IMAGEN },
  "image/webp": { ext: ".webp", firma: "52494646", maxBytes: MAX_IMAGEN },
  "image/gif": { ext: ".gif", firma: "47494638", maxBytes: MAX_IMAGEN },
  "application/pdf": { ext: ".pdf", firma: "25504446", maxBytes: MAX_PDF },
};

/** El tope más alto de todos: lo que el transporte tiene que dejar pasar. */
export const MAX_BYTES_ADJUNTO = MAX_PDF;

/** Solo las extensiones, que es lo que el resto del módulo necesita. */
export const TIPOS: Record<string, string> = Object.fromEntries(
  Object.entries(FORMATOS).map(([tipo, f]) => [tipo, f.ext]),
);

/**
 * Las imágenes nada más, sin el PDF.
 *
 * Para donde una imagen es una imagen y punto: una foto de perfil se pinta en un
 * círculo de 34 píxeles, y un PDF ahí no significa nada.
 */
export const TIPOS_DE_IMAGEN: Record<string, string> = Object.fromEntries(
  Object.entries(FORMATOS)
    .filter(([tipo]) => tipo.startsWith("image/"))
    .map(([tipo, f]) => [tipo, f.ext]),
);

/**
 * ¿El archivo es de verdad lo que dice ser?
 *
 * Se mira el principio del contenido, no el nombre ni lo que declaró el
 * navegador. Un WebP empieza con "RIFF" y trae "WEBP" en el byte 8, pero con los
 * cuatro primeros basta para lo que hace falta aquí.
 */
function firmaCuadra(buf: Buffer, formato: Formato): boolean {
  return buf.subarray(0, formato.firma.length / 2).toString("hex") === formato.firma;
}

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
  if (typeof nombre !== "string" || !nombre.trim()) return "archivo";
  return nombre.replace(/[/\\]/g, "_").slice(0, 80);
}

export class AdjuntoInvalido extends Error {}

/**
 * Guarda un archivo del chat y devuelve con qué referirse a él.
 *
 * El id NO deriva del nombre que mandó la persona. Se genera aquí, y lleva solo
 * la extensión que corresponde al mediaType declarado. Así ningún nombre de
 * archivo de fuera decide dónde se escribe: es la misma idea que `safePath` en
 * las tools, resuelta antes de que haya una ruta que validar.
 */
export async function guardarAdjunto(
  workspaceDir: string,
  entrada: { nombre?: unknown; mediaType?: unknown; data?: unknown; bytes?: Buffer },
): Promise<Adjunto> {
  const mediaType = typeof entrada.mediaType === "string" ? entrada.mediaType : "";
  const formato = FORMATOS[mediaType];
  if (!formato) {
    throw new AdjuntoInvalido(
      `formato no soportado: ${mediaType || "(ninguno)"}. Solo PNG, JPEG, WebP, GIF y PDF.`,
    );
  }

  // Los bytes pueden venir ya leídos (subida por HTTP, que es el camino normal)
  // o en base64 (lo que queda del camino viejo y lo que usan las demos).
  let buf: Buffer;
  if (entrada.bytes) {
    buf = entrada.bytes;
  } else {
    if (typeof entrada.data !== "string" || !entrada.data) {
      throw new AdjuntoInvalido("el archivo llegó vacío");
    }
    buf = Buffer.from(entrada.data, "base64");
  }

  if (buf.length === 0) {
    throw new AdjuntoInvalido("el archivo llegó vacío");
  }
  if (buf.length > formato.maxBytes) {
    const mb = (buf.length / 1024 / 1024).toFixed(1);
    const tope = Math.round(formato.maxBytes / 1024 / 1024);
    throw new AdjuntoInvalido(`el archivo pesa ${mb}MB y el tope son ${tope}MB`);
  }

  // Que el contenido sea lo que dice ser. El mediaType lo pone el navegador y se
  // puede cambiar: sin esta comprobación, un ejecutable renombrado a .pdf se
  // guarda, se le sirve al resto de la sala, y alguien lo abre confiado.
  if (!firmaCuadra(buf, formato)) {
    throw new AdjuntoInvalido(
      `el archivo dice ser ${mediaType} pero su contenido no lo es`,
    );
  }

  // El nombre visible va DENTRO del id, después del uuid, para poder buscar por
  // él sin llevar un índice aparte. El uuid delante es lo que garantiza que dos
  // capturas llamadas igual no se pisen, y que el nombre de fuera no decida nada.
  const nombre = nombreVisible(entrada.nombre);
  const id = `${randomUUID()}__${sanearParaDisco(nombre, formato.ext)}`;
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
  return `${base || "archivo"}${ext}`;
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
