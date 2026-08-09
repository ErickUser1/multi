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

/**
 * Lo que es de la SALA y nunca del preview.
 *
 * Está al revés a propósito. Antes había una lista blanca de lo que sí va al
 * preview (`/@vite/`, `/src/`, …) y funcionaba mientras el proyecto solo pidiera
 * módulos: Vite los inyecta con rutas absolutas desde la raíz del origen y no se
 * pueden reconfigurar (`server.origin` solo afecta URLs de plugins, no las
 * transforms core — vitejs/vite discussions #21676).
 *
 * Pero el proyecto también sirve su carpeta `public/`, y ahí cabe cualquier cosa:
 * `/logo.png`, `/favicon.ico`, una fuente, un PDF. Ninguno empieza con un prefijo
 * conocido, así que la lista blanca los rechazaba y el navegador recibía el HTML
 * de la Sala en vez del archivo. Se vio con una imagen que el agente puso en el
 * header: el `<img>` correcto, el archivo en su sitio, y el icono de rota.
 *
 * Enumerar lo del preview es imposible (depende del proyecto); enumerar lo de la
 * Sala sí se puede, porque es nuestro y cambia solo cuando lo cambiamos.
 */
const RUTAS_DE_LA_SALA = [
  "/health",
  "/rooms",
  "/providers",
  "/preview",
  "/socket.io",
  // El build de la Sala (Vite compila a /assets/ y sirve estos en la raíz).
  "/assets/",
  "/index.html",
  "/vite.svg",
];

/** Nombre de la cookie que recuerda a qué sala pertenece esta pestaña del preview. */
const ROOM_COOKIE = "multi_room";

/** Lee el roomId de la cookie (si viene). */
function roomFromCookie(cookieHeader?: string): string | null {
  if (!cookieHeader) return null;
  const m = cookieHeader.match(new RegExp(`${ROOM_COOKIE}=([a-z0-9-]{1,64})`, "i"));
  return m ? m[1] : null;
}

/**
 * ¿Es una request al proxy del preview? Devuelve {roomId, rest} o null.
 *
 * Resolver la sala de los assets de raíz tiene dos vías, por orden:
 *  1. Referer — funciona para recursos pedidos por atributos (<script src>).
 *  2. Cookie — necesaria porque los IMPORTS DE MÓDULOS ES (import "/src/x.js")
 *     NO envían Referer por estándar. Sin esto, React nunca arranca y el
 *     preview queda en blanco. La cookie se setea al servir la página.
 */
export function parsePreviewUrl(
  url: string,
  headers: { referer?: string; cookie?: string },
): { roomId: string; rest: string } | null {
  // Caso 1: URL explícita bajo /preview/:roomId/...
  if (url.startsWith(PREFIX)) {
    const after = url.slice(PREFIX.length);
    const slash = after.indexOf("/");
    const roomId = slash === -1 ? after : after.slice(0, slash);
    const rest = slash === -1 ? "/" : after.slice(slash) || "/";
    if (!ROOM_ID_RE.test(roomId)) return null;
    return { roomId, rest };
  }

  // La raíz SIEMPRE es la Sala. La cookie del preview sobrevive en la pestaña,
  // así que sin esto abrir Multi después de ver un preview te daría la app del
  // proyecto en lugar de la Sala.
  const soloRuta = url.split("?")[0];
  if (soloRuta === "/") return null;

  // Caso 2: algo pedido desde la RAÍZ del origen. Puede ser un módulo que Vite
  // inyectó (/src/main.jsx, /@vite/client) o un archivo del `public/` del
  // proyecto (/logo.png, /favicon.ico): cualquier cosa que no sea nuestra.
  if (RUTAS_DE_LA_SALA.some((p) => soloRuta === p || soloRuta.startsWith(p))) return null;

  // Y solo si sabemos de qué sala viene. Sin eso no hay a dónde mandarlo, y una
  // petición suelta a la raíz debe seguir cayendo en la Sala.
  const fromReferer = headers.referer?.match(/\/preview\/([a-z0-9-]{1,64})(?:\/|$)/i)?.[1];
  const roomId = fromReferer ?? roomFromCookie(headers.cookie);
  if (!roomId) return null;
  return { roomId, rest: url };
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
  const parsed = parsePreviewUrl(req.url ?? "", {
    referer: req.headers.referer,
    cookie: req.headers.cookie,
  });
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

      // Recordar la sala en una cookie: los imports de módulos ES no mandan
      // Referer, así que sin esto los assets de raíz no se pueden atribuir a
      // ninguna sala y el preview queda en blanco.
      headers["set-cookie"] = `${ROOM_COOKIE}=${parsed.roomId}; Path=/; SameSite=Lax`;

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
  // El HMR de Vite abre su WebSocket contra la RAÍZ ("/"), no bajo /preview/ ni
  // bajo ninguno de los prefijos de asset. Como parsePreviewUrl exige uno de
  // esos, devolvía null, el proxy decía "no es mío" y nadie atendía el upgrade:
  // socket hang up. Ese era el bug — los archivos se servían bien (por eso al
  // refrescar sí se veían los cambios) pero el canal de avisos nunca existía.
  //
  // Aquí la cookie basta para saber de qué sala es: un upgrade que la trae y no
  // es de socket.io solo puede ser el HMR del preview de esa sala.
  const parsed =
    parsePreviewUrl(req.url ?? "", {
      referer: req.headers.referer,
      cookie: req.headers.cookie,
    }) ?? upgradeDelPreview(req);

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
  // Si el cliente se va, no dejar la conexión al dev server colgada.
  socket.on("error", () => upstream.destroy());
  socket.on("close", () => upstream.destroy());

  // Los bytes que llegaron pegados al handshake se reenvían tal cual; el resto
  // fluye por los pipes que se tienden en el evento "upgrade".
  //
  // El end() SÍ hace falta: cierra el lado de escritura para que Node mande la
  // petición de upgrade. Sin él la petición nunca sale y el cliente se queda
  // esperando (medido: "sin respuesta en 8s"). El túnel bidireccional se tiende
  // después, sobre el socket crudo, no sobre este request.
  if (head && head.length) upstream.write(head);
  upstream.end();
  return true;
}

/**
 * Inyecta el inspector en el HTML. NO reescribe rutas.
 *
 * Las rutas absolutas que emite el dev server (/@vite/client, /src/main.jsx,
 * /node_modules/…) se dejan tal cual y se proxean desde la raíz resolviendo la
 * sala por Referer (ver ROOT_PREFIXES). Reescribirlas era un juego de topos:
 * había que cubrir atributos, imports inline, imports dentro de cada .js
 * servido… La solución de la comunidad de Vite es proxear, no reescribir.
 */
function transformHtml(html: string, _basePath: string): string {
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

/**
 * ¿Este upgrade es el HMR de un preview?
 *
 * Vite abre su WebSocket contra la raíz, así que no se puede distinguir por la
 * ruta. Se distingue por dos cosas: que traiga la cookie de sala (la puso el
 * proxy al servir la página del preview) y que NO sea el socket.io de la Sala,
 * que vive bajo /socket.io/.
 */
function upgradeDelPreview(req: IncomingMessage): { roomId: string; rest: string } | null {
  const url = req.url ?? "/";
  if (url.startsWith("/socket.io")) return null;

  const roomId = roomFromCookie(req.headers.cookie);
  if (!roomId) return null;

  return { roomId, rest: url };
}
