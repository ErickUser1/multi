import { readFile, writeFile, mkdir, rename, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import {
  type Tool,
  type ToolContext,
  ToolError,
  safePath,
  reqString,
  optBool,
} from "./base.js";

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
    await mkdir(dirname(p), { recursive: true });
    await atomicWrite(p, content);
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
    await atomicWrite(p, updated);
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

/** Escritura atómica: temp + rename. Evita archivos a medias si crashea. */
async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
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
