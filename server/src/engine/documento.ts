import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname } from "node:path";

/**
 * Dónde vive el documento de una sala y lo que se sirve de él.
 *
 * ```
 * documento/
 *   doc.yjs        el documento vivo (ver doc-vivo.ts)
 *   documento.md   su exportación, regenerada en cada guardado
 *   imagenes/…     las imágenes, archivos de verdad
 * ```
 *
 * Dentro del workspace y no en una base aparte: el historial por turno y
 * "volver atrás" salen del git de la sala, y el zip que se descarga los incluye.
 *
 * El formato anterior (documento.json + secciones/*.md, un archivo por sección)
 * solo se lee para convertirlo al vivo la primera vez que se abre.
 */

export const CARPETA_DOCUMENTO = "documento";
/** El documento vivo: el estado de Yjs. Es la fuente de verdad (ver doc-vivo.ts). */
export const ARCHIVO_YJS = "doc.yjs";
/** Su exportación en markdown, regenerada en cada guardado: diffs legibles en el historial. */
export const ARCHIVO_MD = "documento.md";
/** El índice del formato anterior (#109). Solo se lee para migrarlo. */
const INDICE = "documento.json";
const SECCIONES = "secciones";
export const CARPETA_IMAGENES = "imagenes";

/** Lo que va en una sección recién sembrada, antes de que nadie la escriba. */
const PENDIENTE = /<!--\s*pendiente:\s*([\s\S]*?)\s*-->/;

export type TipoDeSala = "app" | "documento";

export interface SeccionDelIndice {
  id: string;
  archivo: string;
}

export interface SeccionLeida {
  id: string;
  archivo: string;
  /** El markdown sin la marca de pendiente. */
  markdown: string;
  /** Qué va a ir aquí, mientras nadie la escriba. null si ya tiene contenido. */
  pendiente: string | null;
}

export interface DocumentoLeido {
  titulo: string;
  secciones: SeccionLeida[];
}

/** ¿Esta sala es un documento? Lo dice el disco, no una columna aparte. */
export function esDocumento(workspaceDir: string): boolean {
  return (
    existsSync(join(workspaceDir, CARPETA_DOCUMENTO, ARCHIVO_YJS)) || esDocumentoViejo(workspaceDir)
  );
}

/** ¿Es un documento del formato anterior, de archivos markdown por sección? */
export function esDocumentoViejo(workspaceDir: string): boolean {
  return existsSync(join(workspaceDir, CARPETA_DOCUMENTO, INDICE));
}

/**
 * Un id o nombre de archivo que se puede usar sin salir de la carpeta.
 *
 * El índice lo escribe el agente, así que puede traer cualquier cosa. Solo se
 * aceptan nombres planos: nada de `../`, ni carpetas, ni rutas absolutas.
 */
export function nombreSeguro(nombre: string): boolean {
  return /^[a-z0-9][a-z0-9_.-]{0,80}$/i.test(nombre) && !nombre.includes("..");
}

/**
 * Lee el documento para pintarlo.
 *
 * Tolerante a propósito: el índice lo mantiene el agente y puede quedar a medio
 * escribir o apuntar a una sección que todavía no existe. Lo que no se entiende
 * se salta en vez de tirar la vista entera.
 */
export async function leerDocumento(workspaceDir: string): Promise<DocumentoLeido | null> {
  const dir = join(workspaceDir, CARPETA_DOCUMENTO);
  let indice: { titulo?: unknown; secciones?: unknown };
  try {
    indice = JSON.parse(await readFile(join(dir, INDICE), "utf8"));
  } catch {
    return null;
  }

  const titulo = typeof indice.titulo === "string" ? indice.titulo : "";
  const lista = Array.isArray(indice.secciones) ? indice.secciones : [];
  const secciones: SeccionLeida[] = [];
  const vistos = new Set<string>();

  for (const item of lista) {
    const archivo = typeof item === "string" ? item : (item as { archivo?: unknown })?.archivo;
    if (typeof archivo !== "string" || !nombreSeguro(archivo) || extname(archivo) !== ".md") continue;
    if (vistos.has(archivo)) continue;
    vistos.add(archivo);
    const idCrudo = typeof item === "object" && item ? (item as { id?: unknown }).id : undefined;
    const id = typeof idCrudo === "string" && nombreSeguro(idCrudo) ? idCrudo : archivo.replace(/\.md$/, "");

    let texto = "";
    try {
      texto = await readFile(join(dir, SECCIONES, archivo), "utf8");
    } catch {
      // Listada pero sin archivo: se muestra como pendiente sin intención.
      secciones.push({ id, archivo, markdown: "", pendiente: "" });
      continue;
    }
    const marca = texto.match(PENDIENTE);
    secciones.push({
      id,
      archivo,
      markdown: texto.replace(PENDIENTE, "").trim(),
      pendiente: marca ? marca[1].trim() : null,
    });
  }

  return { titulo, secciones };
}

const TIPOS_DE_IMAGEN: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/**
 * La ruta y el tipo de una imagen del documento, o null si el nombre no es
 * válido. SVG queda fuera a propósito: puede traer código, y se sirve desde el
 * mismo origen que la Sala.
 */
export function imagenDelDocumento(workspaceDir: string, nombre: string): { ruta: string; tipo: string } | null {
  if (!nombreSeguro(nombre)) return null;
  const tipo = TIPOS_DE_IMAGEN[extname(nombre).toLowerCase()];
  if (!tipo) return null;
  const ruta = join(workspaceDir, CARPETA_DOCUMENTO, CARPETA_IMAGENES, nombre);
  return existsSync(ruta) ? { ruta, tipo } : null;
}
