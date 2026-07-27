import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/**
 * El back visual: deduce el "contrato" entre el front y el back leyendo el
 * workspace, sin ejecutar nada.
 *
 * La idea del producto: el backend es la caja negra que el usuario no-técnico
 * no puede ver. Este mapa la abre — qué endpoints llama el front, cuáles
 * existen de verdad, y cuáles están colgando en el aire.
 *
 * Es una HEURÍSTICA sobre el texto del código, no un compilador. Detecta las
 * formas normales de escribir una llamada o una ruta; las construidas en
 * runtime (`fetch(url)` con la url armada aparte) no se ven. Es aceptable:
 * el canvas es una ayuda para entender, no una fuente de verdad.
 */

export type EndpointStatus =
  /** El front lo llama pero nadie lo implementó — la card punteada. */
  | "faltante"
  /** Existe en el back Y alguien lo llama. */
  | "conectado"
  /** Existe en el back pero ningún front lo llama. */
  | "huerfano";

export interface CallSite {
  /** Ruta relativa al workspace, ej. "src/Menu.jsx". */
  file: string;
  line: number;
}

export interface Endpoint {
  /** Clave estable: "GET /api/pedidos". */
  id: string;
  method: string;
  path: string;
  status: EndpointStatus;
  /** Dónde lo llama el front. Vacío si es huérfano. */
  calls: CallSite[];
  /** Dónde está declarado en el back. null si falta. */
  definedAt: CallSite | null;
}

export interface ApiMap {
  endpoints: Endpoint[];
  /** Para que la UI pueda decir "todavía no hay nada que mostrar". */
  scannedFiles: number;
}

const CODE_EXT = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".vue", ".svelte"]);

// Carpetas que nunca aportan y sí cuestan: deps, builds, el propio git.
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".svelte-kit",
  "coverage",
  ".cache",
  ".vite",
]);

const MAX_FILES = 400;
const MAX_FILE_BYTES = 400_000;

/**
 * Llamadas del front. Cubre las formas comunes:
 *   fetch("/api/x")            fetch('/api/x', { method: "POST" })
 *   axios.post("/api/x")       $fetch("/api/x")       useSWR("/api/x")
 *
 * Solo rutas que empiezan con "/" — una URL absoluta a otro dominio es un
 * servicio de terceros, no el back de este proyecto.
 */
const CALL_PATTERNS: Array<{ re: RegExp; methodFrom: "group" | "options" | "get" }> = [
  // axios.post("/api/x") | http.put(`/api/x`) — el método va en el nombre.
  {
    re: /\b(?:axios|http|api|client)\s*\.\s*(get|post|put|patch|delete)\s*\(\s*[`'"](\/[^`'"\s?]*)/gi,
    methodFrom: "group",
  },
  // fetch("/api/x", { method: "POST" }) — el método va en las opciones (o es GET).
  {
    re: /\b(?:fetch|\$fetch|ofetch)\s*\(\s*[`'"](\/[^`'"\s?]*)[`'"]\s*(?:,\s*(\{[^}]*\}))?/gi,
    methodFrom: "options",
  },
  // useSWR("/api/x") | useQuery(..., "/api/x") — data fetching declarativo, siempre GET.
  {
    re: /\b(?:useSWR|useFetch|useAsyncData|useQuery)\s*\([^)]*?[`'"](\/[^`'"\s?]*)/gi,
    methodFrom: "get",
  },
];

/**
 * Rutas declaradas en el back. Cubre Express/Fastify/Koa/Hono:
 *   app.get("/api/x")   router.post("/api/x")   fastify.get("/api/x")
 * y los handlers por archivo de Next/Nuxt/SvelteKit (ver `routeFromFilePath`).
 */
const ROUTE_RE =
  /\b(?:app|router|fastify|server|api|r)\s*\.\s*(get|post|put|patch|delete|all)\s*(?:<[^>]*>)?\s*\(\s*[`'"](\/[^`'"\s]*)/gi;

export async function buildApiMap(workspaceDir: string): Promise<ApiMap> {
  const files = await listCodeFiles(workspaceDir);

  const calls = new Map<string, CallSite[]>();
  const routes = new Map<string, CallSite>();

  for (const abs of files) {
    let text: string;
    try {
      text = await readFile(abs, "utf8");
    } catch {
      continue; // borrado entre el listado y la lectura: no es un error del mapa
    }
    if (text.length > MAX_FILE_BYTES) continue;

    const rel = toPosix(relative(workspaceDir, abs));

    for (const { id, line } of findCalls(text)) {
      const list = calls.get(id) ?? [];
      // Un mismo endpoint llamado dos veces en el mismo archivo no aporta.
      if (!list.some((c) => c.file === rel && c.line === line)) list.push({ file: rel, line });
      calls.set(id, list);
    }

    for (const { id, line } of findRoutes(text, rel)) {
      // La primera declaración gana — con router anidados puede haber varias.
      if (!routes.has(id)) routes.set(id, { file: rel, line });
    }
  }

  const endpoints: Endpoint[] = [];
  for (const id of new Set([...calls.keys(), ...routes.keys()])) {
    const [method, path] = splitId(id);
    const callSites = calls.get(id) ?? [];
    const definedAt = routes.get(id) ?? null;
    endpoints.push({
      id,
      method,
      path,
      status: !definedAt ? "faltante" : callSites.length > 0 ? "conectado" : "huerfano",
      calls: callSites,
      definedAt,
    });
  }

  // Lo que falta primero: es lo accionable ("@agente crea este endpoint").
  const orden: Record<EndpointStatus, number> = { faltante: 0, conectado: 1, huerfano: 2 };
  endpoints.sort((a, b) => orden[a.status] - orden[b.status] || a.path.localeCompare(b.path));

  return { endpoints, scannedFiles: files.length };
}

// ── el escaneo de texto ──────────────────────────────────────────────────────

function findCalls(text: string): Array<{ id: string; line: number }> {
  const out: Array<{ id: string; line: number }> = [];

  for (const { re, methodFrom } of CALL_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      let method: string;
      let path: string;

      if (methodFrom === "group") {
        method = m[1].toUpperCase();
        path = m[2];
      } else if (methodFrom === "options") {
        path = m[1];
        method = methodFromOptions(m[2]);
      } else {
        path = m[1];
        method = "GET";
      }

      if (!isApiPath(path)) continue;
      out.push({ id: makeId(method, path), line: lineAt(text, m.index) });
    }
  }
  return out;
}

function findRoutes(text: string, relPath: string): Array<{ id: string; line: number }> {
  const out: Array<{ id: string; line: number }> = [];

  ROUTE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ROUTE_RE.exec(text)) !== null) {
    const method = m[1].toUpperCase();
    const path = m[2];
    if (!isApiPath(path)) continue;
    // `.all()` responde a cualquier método; lo tratamos como GET, el caso normal.
    out.push({ id: makeId(method === "ALL" ? "GET" : method, path), line: lineAt(text, m.index) });
  }

  // Convención de archivo (Next/Nuxt/SvelteKit): la ruta ES la carpeta.
  const porArchivo = routeFromFilePath(relPath);
  if (porArchivo) {
    for (const method of methodsExportedIn(text)) {
      out.push({ id: makeId(method, porArchivo), line: 1 });
    }
  }

  return out;
}

/**
 * Traduce la ruta de un archivo a la ruta HTTP que sirve, en los frameworks que
 * enrutan por sistema de archivos. Devuelve null si el archivo no es una ruta.
 */
function routeFromFilePath(relPath: string): string | null {
  // pages/api/pedidos.ts | app/api/pedidos/route.ts | server/api/pedidos.get.ts
  const m = relPath.match(/(?:^|\/)(?:src\/)?(?:pages|app|server|routes)\/api\/(.+)$/);
  if (!m) return null;

  let ruta = m[1]
    .replace(/\.(js|jsx|ts|tsx|mjs|cjs)$/, "")
    .replace(/\/(route|index)$/, "")
    .replace(/^(route|index)$/, "")
    // server/api/pedidos.get.ts → el método va en el nombre; la ruta no lo lleva.
    .replace(/\.(get|post|put|patch|delete)$/i, "")
    // [id] y [...slug] → parámetros; se normalizan como :param para poder cruzar.
    .replace(/\[\.\.\.(\w+)\]/g, ":$1")
    .replace(/\[(\w+)\]/g, ":$1");

  ruta = ruta.replace(/\/+$/, "");
  return `/api${ruta ? `/${ruta}` : ""}`;
}

/** Los métodos que un handler por archivo exporta: `export function GET(...)`. */
function methodsExportedIn(text: string): string[] {
  const found = new Set<string>();
  const re = /export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) found.add(m[1]);
  // Sin exports nombrados (Express-style `export default handler`) asumimos GET:
  // es lo más común y deja la card visible en vez de invisible.
  if (found.size === 0 && /export\s+default/.test(text)) found.add("GET");
  return [...found];
}

function methodFromOptions(options: string | undefined): string {
  if (!options) return "GET";
  const m = options.match(/method\s*:\s*[`'"](\w+)[`'"]/i);
  return m ? m[1].toUpperCase() : "GET";
}

/**
 * Filtra lo que no es una llamada al back propio: rutas de navegación,
 * assets, y las rutas internas de Vite que el proxy ya maneja.
 */
function isApiPath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  if (/\.(css|js|png|jpe?g|svg|gif|webp|ico|woff2?|json|map)$/i.test(path)) return false;
  if (path.startsWith("/@") || path.startsWith("/node_modules")) return false;
  if (path.includes("${")) return false; // template con interpolación: no sabemos la ruta real
  // Solo lo que parece backend. Sin esto, cada <Link to="/precios"> sería un endpoint.
  return /^\/(api|trpc|graphql|rest|v\d+)\b/.test(path);
}

function makeId(method: string, path: string): string {
  // Sin barra final: "/api/x/" y "/api/x" son el mismo endpoint.
  const limpio = path.length > 1 ? path.replace(/\/+$/, "") : path;
  return `${method} ${limpio}`;
}

function splitId(id: string): [string, string] {
  const i = id.indexOf(" ");
  return [id.slice(0, i), id.slice(i + 1)];
}

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function toPosix(p: string): string {
  return sep === "\\" ? p.split(sep).join("/") : p;
}

// ── el recorrido del workspace ───────────────────────────────────────────────

async function listCodeFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const pending: string[] = [root];

  while (pending.length > 0 && out.length < MAX_FILES) {
    const dir = pending.shift()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // sin permisos o borrado mientras escaneábamos
    }

    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".") continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) pending.push(abs);
      } else if (CODE_EXT.has(extOf(e.name))) {
        out.push(abs);
        if (out.length >= MAX_FILES) break;
      }
    }
  }
  return out;
}

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i).toLowerCase();
}
