import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname } from "node:path";

/**
 * El documento de una sala: archivos dentro del workspace, no una base aparte.
 *
 * ```
 * documento/
 *   documento.json          { "titulo": "...", "secciones": [{ "id": "...", "archivo": "01-intro.md" }] }
 *   secciones/01-intro.md   markdown de la sección
 *   imagenes/…
 * ```
 *
 * Archivos y no una tabla por tres razones. El agente los toca con las mismas
 * tools de siempre, así que los candados y la escritura condicional por archivo
 * ya cubren a dos agentes escribiendo secciones distintas a la vez. El historial
 * por turno y "volver atrás" salen gratis del git de la sala. Y el zip que se
 * descarga hoy ya los incluye.
 *
 * Una sección por archivo a propósito: dos agentes en el mismo archivo se
 * esperan; en archivos distintos trabajan a la vez.
 */

export const CARPETA_DOCUMENTO = "documento";
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

export function slug(texto: string): string {
  const base = texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "seccion";
}

export interface SeccionNueva {
  titulo: string;
  intencion: string;
}

/**
 * Los archivos de un documento recién empezado: el índice y una sección
 * pendiente por parte. Devuelve rutas relativas al workspace y su contenido;
 * quién y cómo los escribe es cosa de quien llama (la tool usa la escritura
 * condicional, la demo escribe directo).
 */
export function archivosDelEsqueleto(titulo: string, secciones: SeccionNueva[]): { ruta: string; contenido: string }[] {
  const usados = new Set<string>();
  const indice: SeccionDelIndice[] = [];
  const archivos: { ruta: string; contenido: string }[] = [];

  secciones.forEach((s, i) => {
    let id = slug(s.titulo);
    while (usados.has(id)) id = `${id}-${i + 1}`;
    usados.add(id);
    const archivo = `${String(i + 1).padStart(2, "0")}-${id}.md`;
    indice.push({ id, archivo });
    const intencion = s.intencion.replace(/-->/g, "—").trim();
    archivos.push({
      ruta: `${CARPETA_DOCUMENTO}/${SECCIONES}/${archivo}`,
      contenido: `## ${s.titulo.trim()}\n\n<!-- pendiente: ${intencion} -->\n`,
    });
  });

  archivos.unshift({
    ruta: `${CARPETA_DOCUMENTO}/${INDICE}`,
    contenido: JSON.stringify({ titulo: titulo.trim(), secciones: indice }, null, 2) + "\n",
  });
  return archivos;
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
