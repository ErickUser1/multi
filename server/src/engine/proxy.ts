import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { getRoom } from "../rooms.js";
import { INSPECTOR_SCRIPT } from "./inspector.js";

/**
 * Reverse proxy del preview — patrón ui-annotator-mcp, con http de Node puro.
 *
 * El iframe de la sala apunta a  /preview/:roomId/...  (en este server).
 * El proxy reenvía al dev server de esa sala (localhost:PUERTO) y, para las
 * respuestas HTML, inyecta el script inspector antes de </body>, reescribe
 * rutas absolutas para que pasen por el proxy, y quita el header CSP.
 *
 * Agnóstico al stack: intercepta cualquier HTML, no toca el proyecto.
 * Same-origin: el iframe y el inspector viven bajo el origen del server.
 */

const PREFIX = "/preview/";
// roomId solo puede ser alfanumérico + guiones (formato de genId). Validar en el
// borde público del proxy blinda contra SSRF / traversal por un id manipulado.
const ROOM_ID_RE = /^[a-z0-9-]{1,64}$/i;

/** ¿Es una request al proxy del preview? Devuelve {roomId, rest} o null. */
function parsePreviewUrl(url: string): { roomId: string; rest: string } | null {
  if (!url.startsWith(PREFIX)) return null;
  const after = url.slice(PREFIX.length);
  const slash = after.indexOf("/");
  const roomId = slash === -1 ? after : after.slice(0, slash);
  const rest = slash === -1 ? "/" : after.slice(slash) || "/";
  if (!ROOM_ID_RE.test(roomId)) return null; // id inválido → no es una URL de preview válida
  return { roomId, rest };
}

/** Puerto del dev server de una sala, o null si aún no arrancó. */
function roomPreviewPort(roomId: string): number | null {
  const room = getRoom(roomId);
  return room?.preview?.port ?? null;
}

/**
 * Maneja una request HTTP del preview. Se engancha ANTES de Fastify, sobre el
 * http.Server crudo (para poder transformar el body sin que Fastify lo toque).
 * Devuelve true si manejó la request; false si no era del proxy.
 */
export function handlePreviewRequest(req: IncomingMessage, res: ServerResponse): boolean {
  const D = process.env.PROXY_DEBUG === "1";
  const parsed = parsePreviewUrl(req.url ?? "");
  if (D) console.log(`[proxy] IN url=${req.url} parsed=${JSON.stringify(parsed)}`);
  if (!parsed) return false;

  const port = roomPreviewPort(parsed.roomId);
  if (D) console.log(`[proxy] sala=${parsed.roomId} puerto=${port}`);
  if (!port) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end("preview de la sala aún no está listo");
    return true;
  }

  const basePath = `${PREFIX}${parsed.roomId}`;

  // Limpiar headers del cliente que rompen el proxy:
  //  - accept-encoding: pedir SIN comprimir para poder leer/transformar el HTML.
  //  - host: apuntarlo al dev server.
  //  - connection: dejar que Node maneje keep-alive.
  const fwdHeaders = { ...req.headers };
  delete fwdHeaders["accept-encoding"];
  delete fwdHeaders["connection"];
  fwdHeaders["host"] = `127.0.0.1:${port}`;

  const upstream = httpRequest(
    {
      host: "127.0.0.1",
      port,
      method: req.method,
      path: parsed.rest,
      headers: fwdHeaders,
    },
    (up) => {
      const contentType = String(up.headers["content-type"] ?? "");
      const isHtml = contentType.includes("text/html");
      if (D) console.log(`[proxy] UP status=${up.statusCode} type=${contentType} isHtml=${isHtml}`);

      // Headers a reenviar, quitando CSP (para permitir el script inyectado)
      // y content-length (el body va a cambiar de tamaño al inyectar).
      const headers: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(up.headers)) {
        const key = k.toLowerCase();
        if (key === "content-security-policy") continue;
        if (key === "content-length" && isHtml) continue;
        if (v !== undefined) headers[k] = v as string | string[];
      }

      if (!isHtml) {
        // Passthrough directo (CSS, JS, imágenes, HMR client, etc.).
        res.writeHead(up.statusCode ?? 200, headers);
        up.pipe(res);
        return;
      }

      // HTML: bufferizar, transformar, reenviar.
      const chunks: Buffer[] = [];
      up.on("data", (c) => chunks.push(c));
      up.on("end", () => {
        let html = Buffer.concat(chunks).toString("utf8");
        if (D) console.log(`[proxy] HTML recibido: ${html.length} chars`);
        html = transformHtml(html, basePath);
        if (D) console.log(`[proxy] HTML transformado: ${html.length} chars, inspector=${html.includes("multiInspector")}`);
        const body = Buffer.from(html, "utf8");
        headers["content-length"] = String(body.length);
        res.writeHead(up.statusCode ?? 200, headers);
        res.end(body);
      });
    },
  );

  upstream.on("error", (err) => {
    console.error(
      `[proxy] error upstream: sala=${parsed.roomId} puerto=${port} path=${parsed.rest} método=${req.method}`,
      err,
    );
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end(`error al conectar con el dev server: ${String(err)}`);
    } else {
      res.destroy();
    }
  });

  // Si el cliente corta la conexión ANTES de que terminemos de responder,
  // abortar el upstream para no dejar conexiones colgadas al dev server.
  // OJO: Node emite "close" en `res` también al terminar bien — por eso se
  // comprueba `writableFinished` (si ya terminamos, no hay nada que abortar).
  res.on("close", () => {
    if (!res.writableFinished) upstream.destroy();
  });

  req.pipe(upstream);
  return true;
}

/**
 * Maneja el UPGRADE de WebSocket (el HMR de Vite usa WS). Reenvía el socket
 * crudo al dev server. Devuelve true si lo manejó.
 */
export function handlePreviewUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
  const parsed = parsePreviewUrl(req.url ?? "");
  if (!parsed) return false;

  const port = roomPreviewPort(parsed.roomId);
  if (!port) {
    socket.destroy();
    return true;
  }

  const upstream = httpRequest({
    host: "127.0.0.1",
    port,
    method: req.method,
    path: parsed.rest,
    headers: { ...req.headers, host: `127.0.0.1:${port}` },
  });

  upstream.on("upgrade", (upRes, upSocket, upHead) => {
    // Responder el handshake 101 al cliente y tender el túnel bidireccional.
    const lines = [`HTTP/1.1 101 Switching Protocols`];
    for (const [k, v] of Object.entries(upRes.headers)) {
      if (Array.isArray(v)) v.forEach((vv) => lines.push(`${k}: ${vv}`));
      else if (v !== undefined) lines.push(`${k}: ${v}`);
    }
    socket.write(lines.join("\r\n") + "\r\n\r\n");
    if (upHead && upHead.length) upSocket.unshift(upHead);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
  });

  upstream.on("error", () => socket.destroy());
  // NOTA: escribir el head (bytes que llegaron con el handshake) antes de que el
  // upgrade del upstream haya ocurrido puede adelantarse al socket. Si el HMR
  // reconecta raro bajo carga, revisar aquí primero (mover el write al "upgrade").
  if (head && head.length) upstream.write(head);
  upstream.end();
  return true;
}

/** Inyecta el inspector, reescribe rutas absolutas, para que todo pase por el proxy. */
function transformHtml(html: string, basePath: string): string {
  // Reescribir href="/..." y src="/..." → href="/preview/:room/..."
  // (solo rutas absolutas que empiezan con / y no con //).
  // LIMITACIÓN CONOCIDA (v1): este regex es textual, no parsea el HTML. Puede
  // reescribir de más: URLs dentro de <script>/JSON inline (ej. <script
  // type="application/json"> con datos precargados), o links externos a docs
  // que el usuario puso a propósito. Si aparece un link roto o JSON corrompido
  // en el preview, este regex es el primer sospechoso. Suficiente para Vite/React
  // normal; el fix "bien" es un parser de HTML real (sobre-ingeniería para v1).
  html = html.replace(/\b(href|src)=("|')\/(?!\/)/g, `$1=$2${basePath}/`);

  // Inyectar el script inspector antes de </body> (o al final si no hay body).
  const tag = `<script>${INSPECTOR_SCRIPT}</script>`;
  if (html.includes("</body>")) {
    html = html.replace("</body>", `${tag}</body>`);
  } else {
    html += tag;
  }
  return html;
}

// Placeholder para el registro desde index (si se quisiera como plugin Fastify).
export function createPreviewProxy() {
  return { handlePreviewRequest, handlePreviewUpgrade };
}
