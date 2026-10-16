import { fileURLToPath } from "node:url";
import type { Runner } from "./runner.js";
import type { Captura, PedidoDeCaptura } from "../agent/tools/ver-preview.js";

/**
 * Corre `docker/qa/capturar.mjs` donde corren los comandos de la sala y lee lo
 * que vio.
 *
 * Va por el `Runner`, como `bash`, y no con un Chromium del server: con
 * contenedor, el navegador abre el código del proyecto adentro del encierro; sin
 * él (desarrollo, pruebas) corre aquí con el Chromium de Playwright, igual que
 * todo lo demás de una sala sin aislar.
 */

/** Dónde está el script dentro de la imagen de las salas (ver room.Dockerfile). */
const SCRIPT_EN_CONTENEDOR = "/opt/qa/capturar.mjs";
/** Y en el repo, para cuando no hay contenedor. */
const SCRIPT_LOCAL = fileURLToPath(new URL("../../../docker/qa/capturar.mjs", import.meta.url));

/** Una captura de 1280×2400 en JPEG ronda el MB en base64. Con esto sobra. */
const SALIDA_MAXIMA = 8 * 1024 * 1024;

export async function capturarPreview(
  runner: Runner,
  base: string,
  pedido: PedidoDeCaptura,
): Promise<Captura> {
  const script = runner.isolated ? SCRIPT_EN_CONTENEDOR : SCRIPT_LOCAL;
  // En base64 para que ni la ruta ni nada del pedido pase por el shell como texto.
  const arg = Buffer.from(
    JSON.stringify({ url: base + pedido.ruta, ancho: pedido.ancho, alto: pedido.alto, completa: pedido.completa }),
  ).toString("base64");

  const r = await runner.exec(`node ${JSON.stringify(script)} ${arg}`, {
    timeoutMs: 50_000,
    maxOutput: SALIDA_MAXIMA,
  });
  if (r.timedOut) return { ok: false, error: "el navegador tardó demasiado y se cerró" };

  const linea = r.stdout.trim().split("\n").pop() ?? "";
  try {
    return JSON.parse(linea) as Captura;
  } catch {
    // Un contenedor creado antes de que la imagen trajera navegador no tiene el
    // script. Se dice claro para que el agente siga sin esto en vez de pelearse.
    if (/Cannot find module|ERR_MODULE_NOT_FOUND|No such file/i.test(r.stderr)) {
      return { ok: false, error: "esta sala todavía no tiene navegador (se activa cuando la sala se reinicia)" };
    }
    return { ok: false, error: (r.stderr || r.stdout).trim().split("\n")[0]?.slice(0, 300) || "el navegador no contestó" };
  }
}
