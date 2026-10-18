/**
 * Abre la vista previa en un navegador de verdad y cuenta lo que vio.
 *
 * Lo corre la tool `ver_preview` del agente, DENTRO del contenedor de la sala:
 * la página es código del proyecto, que nadie revisó, y el contenedor es donde
 * ya vive todo lo que el agente ejecuta. Un Chromium en el server lo correría
 * fuera de ese encierro.
 *
 * Uso: node capturar.mjs <json en base64>
 *   { url, ancho, alto, completa }
 *
 * Imprime UNA línea de JSON por stdout, pase lo que pase:
 *   { ok: true, titulo, enBlanco, overlay, errores, imagen, alto }
 *   { ok: false, error }
 */
import { chromium } from "playwright-core";

/** Lo más alto que se captura con `completa`. Más que esto el modelo lo achica y ya no se lee. */
const ALTO_MAXIMO = 2400;
/** Cuántos errores llegan al agente: con los primeros basta para saber qué pasa. */
const MAX_ERRORES = 20;
/** Tope de todo el trabajo. Un proyecto colgado no cuelga el turno del agente. */
const TOPE_MS = 40_000;

let saliendo = false;
/**
 * Escribe el resultado y sale cuando terminó de escribirse, no antes.
 *
 * Hacia un pipe la escritura es asíncrona: un `process.exit` inmediato cortaba
 * la salida en 80 KB, y cualquier captura con fotos llegaba como JSON a medias.
 * Pasó con todas las presentaciones de una sala real.
 *
 * Devuelve una promesa que nunca se cumple: quien hace `await salir(...)` ya no
 * sigue, igual que cuando aquí había un exit. Y solo escribe una vez, por si el
 * tope de tiempo llega mientras otra salida se está escribiendo.
 */
function salir(resultado) {
  if (!saliendo) {
    saliendo = true;
    process.stdout.write(JSON.stringify(resultado) + "\n", () => process.exit(0));
  }
  return new Promise(() => {});
}

setTimeout(() => salir({ ok: false, error: `la página no terminó de cargar en ${TOPE_MS / 1000}s` }), TOPE_MS).unref();

let pedido;
try {
  pedido = JSON.parse(Buffer.from(process.argv[2] ?? "", "base64").toString("utf8"));
} catch {
  await salir({ ok: false, error: "no entendí qué capturar" });
}
const { url, ancho = 1280, alto = 800, completa = false } = pedido;

let navegador;
try {
  navegador = await chromium.launch({
    executablePath: process.env.MULTI_CHROMIUM || undefined,
    // Sin sandbox porque el encierro ya es el contenedor, y el de Chromium no
    // arranca dentro de uno sin privilegios extra. /dev/shm de Docker es de
    // 64MB y con eso Chromium se cae en páginas grandes.
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });
} catch (err) {
  await salir({ ok: false, error: `no se pudo abrir el navegador: ${String(err).split("\n")[0]}` });
}

const errores = [];
function anotar(texto) {
  const limpio = String(texto).trim().slice(0, 400);
  if (limpio && errores.length < MAX_ERRORES && !errores.includes(limpio)) errores.push(limpio);
}

try {
  const pagina = await navegador.newPage({ viewport: { width: ancho, height: alto } });
  pagina.on("console", (m) => {
    // "Failed to load resource" es el eco en consola de un 4xx/5xx que ya se
    // anota abajo con su URL, que es lo que sirve.
    if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) anotar(`consola: ${m.text()}`);
  });
  pagina.on("pageerror", (e) => anotar(`excepción: ${e.message}`));
  pagina.on("requestfailed", (r) => {
    // Los que la propia página cancela al navegar no son un error de la app.
    if (r.failure()?.errorText === "net::ERR_ABORTED") return;
    anotar(`no cargó ${r.url()}: ${r.failure()?.errorText ?? ""}`);
  });
  pagina.on("response", (r) => {
    // El favicon que falta lo pide el navegador solo, no la app.
    if (r.status() >= 400 && !r.url().endsWith("/favicon.ico")) anotar(`${r.status()} en ${r.url()}`);
  });

  await pagina.goto(url, { waitUntil: "load", timeout: 20_000 });
  // El HMR de Vite es un websocket y no cuenta como red ocupada, así que esto
  // sí llega a calmarse. Lo que tarde más que esto, el agente ya no lo espera.
  await pagina.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
  await pagina.waitForTimeout(800);

  const vista = await pagina.evaluate(() => {
    const overlay = document.querySelector("vite-error-overlay");
    const textoOverlay = overlay?.shadowRoot?.textContent?.replace(/\s+/g, " ").trim() ?? "";
    const texto = (document.body?.innerText ?? "").trim();
    // Una página sin texto puede ser una galería o un canvas: solo cuenta como
    // en blanco si tampoco hay nada que se vea.
    const visibles = Array.from(document.querySelectorAll("img,svg,canvas,video,iframe,input,button")).some((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 4 && r.height > 4;
    });
    return {
      titulo: document.title,
      overlay: textoOverlay.slice(0, 1500),
      enBlanco: !overlay && texto.length === 0 && !visibles,
      altoTotal: document.documentElement.scrollHeight,
    };
  });

  const altoCaptura = completa ? Math.min(vista.altoTotal, ALTO_MAXIMO) : alto;
  const imagen = await pagina.screenshot({
    type: "jpeg",
    quality: 70,
    fullPage: completa,
    ...(completa ? { clip: { x: 0, y: 0, width: ancho, height: altoCaptura } } : {}),
  });

  await navegador.close();
  await salir({
    ok: true,
    titulo: vista.titulo,
    enBlanco: vista.enBlanco,
    overlay: vista.overlay,
    errores,
    alto: altoCaptura,
    altoTotal: vista.altoTotal,
    imagen: imagen.toString("base64"),
  });
} catch (err) {
  await navegador?.close().catch(() => {});
  await salir({ ok: false, error: String(err).split("\n")[0].slice(0, 300), errores });
}
