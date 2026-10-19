/**
 * Lo que comparten los scripts del navegador de la sala (capturar y exportar):
 * leer el pedido, abrir Chromium y contestar por stdout sin cortar la salida.
 */
import { chromium } from "playwright-core";

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
export function salir(resultado) {
  if (!saliendo) {
    saliendo = true;
    process.stdout.write(JSON.stringify(resultado) + "\n", () => process.exit(0));
  }
  return new Promise(() => {});
}

/** Corta todo si se pasa del tope: un proyecto colgado no cuelga a quien espera. */
export function tope(ms, mensaje) {
  setTimeout(() => salir({ ok: false, error: mensaje }), ms).unref();
}

/** El JSON en base64 que llega como primer argumento. */
export async function leerPedido(queEs) {
  try {
    return JSON.parse(Buffer.from(process.argv[2] ?? "", "base64").toString("utf8"));
  } catch {
    return salir({ ok: false, error: `no entendí qué ${queEs}` });
  }
}

export async function abrirNavegador() {
  try {
    return await chromium.launch({
      executablePath: process.env.MULTI_CHROMIUM || undefined,
      // Sin sandbox porque el encierro ya es el contenedor, y el de Chromium no
      // arranca dentro de uno sin privilegios extra. /dev/shm de Docker es de
      // 64MB y con eso Chromium se cae en páginas grandes.
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
  } catch (err) {
    return salir({ ok: false, error: `no se pudo abrir el navegador: ${String(err).split("\n")[0]}` });
  }
}
