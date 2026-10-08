import { readFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  type Tool,
  type ToolContext,
  ToolError,
  safePath,
  reqString,
  optBool,
} from "./base.js";
import { fileMutation, StaleContentError } from "../../engine/file-mutation.js";
import { autoresDe } from "../../engine/git.js";

// ── Read ────────────────────────────────────────────────────────────────────

export const readTool: Tool = {
  spec: {
    name: "read_file",
    description:
      "Lee el contenido de un archivo del workspace. Devuelve el texto con números de línea.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Ruta relativa al workspace, ej. src/App.jsx" },
      },
      required: ["path"],
    },
  },
  async run(input, ctx) {
    const p = safePath(ctx.workspaceDir, reqString(input, "path"));
    if (!existsSync(p)) throw new ToolError(`no existe el archivo: ${reqString(input, "path")}`);
    const content = await readFile(p, "utf8");
    // Ya lo vio completo: si luego lo reescribe entero, sabe qué había.
    if (ctx.agentId) fileMutation.registrarVisto(p, ctx.agentId, content);
    // Numerar líneas (como Claude Code) para que el modelo pueda referenciarlas.
    const numbered = content
      .split("\n")
      .map((line, i) => `${String(i + 1).padStart(4, " ")}\t${line}`)
      .join("\n");
    return numbered || "(archivo vacío)";
  },
};

// ── Write ─────────────────────────────────────────────────────────────────

export const writeTool: Tool = {
  spec: {
    name: "write_file",
    description:
      "Crea o sobrescribe un archivo del workspace con el contenido dado. Crea carpetas padre si faltan.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Ruta relativa al workspace" },
        content: { type: "string", description: "Contenido completo del archivo" },
      },
      required: ["path", "content"],
    },
  },
  async run(input, ctx) {
    const rel = reqString(input, "path");
    const content = reqString(input, "content");
    const p = safePath(ctx.workspaceDir, rel);
    noEsDelDocumento(ctx, p);
    await noPisarLoQueNoViste(ctx, p, rel);
    // write es incondicional (crear/sobrescribir a propósito): expected undefined.
    // Igual pasa por el mutex → nunca dos escrituras simultáneas a la misma ruta.
    await casWrite(ctx, { path: p, rel, content });
    // Lo que acaba de escribir entero también lo vio.
    if (ctx.agentId) fileMutation.registrarVisto(p, ctx.agentId, content);
    ctx.emit?.({ type: "file:changed", path: rel, action: "write" });
    return `escrito ${rel} (${content.length} caracteres)`;
  },
};

// ── Edit ────────────────────────────────────────────────────────────────────

export const editTool: Tool = {
  spec: {
    name: "edit_file",
    description:
      "Reemplaza una cadena exacta por otra en un archivo. old_string debe ser único (o usa replace_all). Falla si no matchea o si hay múltiples matches sin replace_all.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Ruta relativa al workspace" },
        old_string: { type: "string", description: "Texto exacto a reemplazar" },
        new_string: { type: "string", description: "Texto nuevo" },
        replace_all: { type: "boolean", description: "Reemplazar todas las ocurrencias" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  async run(input, ctx) {
    const rel = reqString(input, "path");
    const oldStr = reqString(input, "old_string");
    const newStr = reqString(input, "new_string");
    const replaceAll = optBool(input, "replace_all");
    const p = safePath(ctx.workspaceDir, rel);

    noEsDelDocumento(ctx, p);
    if (!existsSync(p)) throw new ToolError(`no existe el archivo: ${rel}`);
    if (oldStr === newStr) throw new ToolError("old_string y new_string son iguales");

    const content = await readFile(p, "utf8");
    const count = countOccurrences(content, oldStr);
    if (count === 0) throw new ToolError(`old_string no se encontró en ${rel}`);
    if (count > 1 && !replaceAll) {
      throw new ToolError(
        `old_string aparece ${count} veces en ${rel}; usa replace_all o dale más contexto para que sea único`,
      );
    }

    const updated = replaceAll
      ? content.split(oldStr).join(newStr)
      : content.replace(oldStr, newStr);

    // CAS: escribe solo si el archivo sigue como lo acabamos de leer. Si otro
    // agente lo cambió en medio, falla con un mensaje que el modelo sabe resolver.
    await casWrite(ctx, { path: p, rel, content: updated, expected: content });
    // Si había visto el archivo completo, también conoce el resultado de su
    // propio cambio. Si no, sigue sin haberlo visto: edit_file no se lo enseña.
    if (ctx.agentId && fileMutation.loVio(p, ctx.agentId, content)) {
      fileMutation.registrarVisto(p, ctx.agentId, updated);
    }
    ctx.emit?.({ type: "file:changed", path: rel, action: "edit" });
    return `editado ${rel} (${count} reemplazo${count > 1 ? "s" : ""})`;
  },
};

// ── Glob ────────────────────────────────────────────────────────────────────

export const globTool: Tool = {
  spec: {
    name: "glob",
    description:
      "Lista archivos del workspace que matchean un patrón glob (ej. src/**/*.jsx, *.json). Devuelve rutas relativas.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Patrón glob, ej. src/**/*.jsx" },
      },
      required: ["pattern"],
    },
  },
  async run(input, ctx) {
    const pattern = reqString(input, "pattern");
    const all = await walkFiles(ctx.workspaceDir);
    const re = globToRegExp(pattern);
    const matches = all.filter((rel) => re.test(rel)).sort();
    return matches.length ? matches.join("\n") : "(sin coincidencias)";
  },
};

// ── Grep ────────────────────────────────────────────────────────────────────

export const grepTool: Tool = {
  spec: {
    name: "grep",
    description:
      "Busca un patrón (regex) en los archivos del workspace. Devuelve las líneas que matchean con su archivo y número de línea.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex a buscar" },
        glob: { type: "string", description: "Filtro glob opcional, ej. *.jsx" },
      },
      required: ["pattern"],
    },
  },
  async run(input, ctx) {
    const pattern = reqString(input, "pattern");
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch (e) {
      throw new ToolError(`regex inválido: ${String(e)}`);
    }
    const globFilter = input.glob ? globToRegExp(String(input.glob)) : null;
    const files = await walkFiles(ctx.workspaceDir);
    const out: string[] = [];
    for (const rel of files) {
      if (globFilter && !globFilter.test(rel)) continue;
      const content = await readFile(join(ctx.workspaceDir, rel), "utf8").catch(() => "");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          out.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
          if (out.length >= 200) break;
        }
      }
      if (out.length >= 200) break;
    }
    return out.length ? out.join("\n") : "(sin coincidencias)";
  },
};

export const fsTools: Tool[] = [readTool, writeTool, editTool, globTool, grepTool];

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Puente entre las tools y el motor de escritura con CAS.
 * Traduce StaleContentError a ToolError para que el mensaje llegue al modelo
 * como tool_result (is_error) y pueda reintentar solo.
 */
/**
 * Que write_file no reescriba un archivo con trabajo de OTRO agente que este no
 * ha visto.
 *
 * El caso real: le pidieron a un agente un cambio grande y rehízo App.tsx de
 * memoria, sin leerlo. Ahí otro agente había conectado su parte (niveles,
 * racha, gráficas); la reescritura la desconectó sin que nadie lo notara, y
 * cuando el build se quejó de esos archivos "sueltos", los borró para que
 * compilara.
 *
 * No prohíbe cambiar lo del otro: pide verlo antes. Después de leerlo, la misma
 * escritura pasa, y puede adaptarlo como haga falta. No aplica a archivos
 * nuevos ni a los que solo ha tocado este agente, así que quien trabaja solo no
 * nota nada.
 */
async function noPisarLoQueNoViste(ctx: ToolContext, p: string, rel: string): Promise<void> {
  const yo = ctx.agentId;
  if (!yo || !existsSync(p)) return;

  const actual = await readFile(p, "utf8");
  if (fileMutation.loVio(p, yo, actual)) return;

  // Los autores salen de los commits (uno por turno, firmado por el agente) y,
  // para lo que aún no llega a un commit, de quién escribió último.
  const autores = new Set(await autoresDe(ctx.workspaceDir, relative(ctx.workspaceDir, p)));
  const enVuelo = fileMutation.ultimoEscritor(p);
  if (enVuelo) autores.add(enVuelo);
  // Solo agentes: los commits de personas son vueltas atrás en el historial,
  // que restauran código que escribió algún agente.
  const otros = [...autores].filter((a) => a !== yo && /^agente-\d+$/.test(a));
  if (otros.length === 0) return;

  const quien = otros.includes(enVuelo ?? "") ? enVuelo! : otros[0];
  throw new ToolError(
    `${rel} tiene trabajo de ${quien} que no has visto. Léelo con read_file antes de reescribirlo: ` +
      `conserva lo suyo y adáptalo a tu cambio (con edit_file si solo cambias una parte). ` +
      `Después de leerlo, esta misma escritura va a pasar.`,
  );
}

/**
 * El documento de la sala no se escribe como archivo: vive en Yjs y lo que hay
 * en documento/ es lo que Multi guarda de él (se sobrescribe al siguiente
 * cambio). Solo las imágenes son archivos de verdad.
 */
function noEsDelDocumento(ctx: ToolContext, p: string): void {
  const rel = relative(ctx.workspaceDir, p).split(/[\\/]/);
  if (rel[0] === "documento" && rel[1] !== "imagenes") {
    throw new ToolError(
      "el documento no se escribe como archivo: usa leer_documento y escribir_seccion, reemplazar_bloque o insertar_bloques",
    );
  }
}

async function casWrite(
  ctx: ToolContext,
  opts: { path: string; rel: string; content: string; expected?: string | null },
): Promise<void> {
  try {
    await fileMutation.writeIfUnchanged({
      path: opts.path,
      content: opts.content,
      expected: opts.expected,
      agentId: ctx.agentId ?? "agente",
      onWait: (holder) => ctx.onWaitStart?.({ path: opts.rel, holder }),
    });
  } catch (err) {
    if (err instanceof StaleContentError) throw new ToolError(err.message);
    throw err;
  } finally {
    ctx.onWaitEnd?.();
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = 0;
  for (;;) {
    const found = haystack.indexOf(needle, idx);
    if (found === -1) break;
    count++;
    idx = found + needle.length;
  }
  return count;
}

/** Camina el workspace y devuelve rutas relativas (POSIX), saltando node_modules/.git. */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".vite"]);

async function walkFiles(root: string, dir = root, acc: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      await walkFiles(root, join(dir, e.name), acc);
    } else if (e.isFile()) {
      acc.push(relative(root, join(dir, e.name)).split(sep).join("/"));
    }
  }
  return acc;
}

/** Convierte un glob simple (*, **, ?) a RegExp. Rutas en POSIX (/). */
function globToRegExp(pattern: string): RegExp {
  // Escapar regex, luego reponer los comodines glob.
  let re = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  re = re
    .replace(/\*\*\//g, "(?:.*/)?") // **/ = cualquier cantidad de carpetas
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*") // * = dentro de un segmento
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${re}$`);
}
