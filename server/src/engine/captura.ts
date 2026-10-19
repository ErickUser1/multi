import { fileURLToPath } from "node:url";
import type { Runner } from "./runner.js";
import type { Captura, PedidoDeCaptura } from "../agent/tools/ver-preview.js";

/**
 * Corre los scripts del navegador de la sala (`docker/qa/`) donde corren los
 * comandos de la sala, y lee lo que contestaron.
 *
 * Va por el `Runner`, como `bash`, y no con un Chromium del server: con
 * contenedor, el navegador abre el código del proyecto adentro del encierro; sin
 * él (desarrollo, pruebas) corre aquí con el Chromium de Playwright, igual que
 * todo lo demás de una sala sin aislar.
 */

/** Dónde están los scripts dentro de la imagen de las salas (ver room.Dockerfile). */
const CARPETA_EN_CONTENEDOR = "/opt/qa";
/** Y en el repo, para cuando no hay contenedor. */
const CARPETA_LOCAL = fileURLToPath(new URL("../../../docker/qa", import.meta.url));

type Respuesta = { ok: true } | { ok: false; error: string };

async function correr<T extends Respuesta>(
  runner: Runner,
  script: "capturar.mjs" | "exportar.mjs",
  pedido: object,
  opts: { timeoutMs: number; maxOutput: number },
): Promise<T | { ok: false; error: string }> {
  const ruta = `${runner.isolated ? CARPETA_EN_CONTENEDOR : CARPETA_LOCAL}/${script}`;
  // En base64 para que ni la ruta ni nada del pedido pase por el shell como texto.
  const arg = Buffer.from(JSON.stringify(pedido)).toString("base64");

  const r = await runner.exec(`node ${JSON.stringify(ruta)} ${arg}`, opts);
  if (r.timedOut) return { ok: false, error: "el navegador tardó demasiado y se cerró" };

  const linea = r.stdout.trim().split("\n").pop() ?? "";
  try {
    return JSON.parse(linea) as T;
  } catch {
    // Un contenedor creado antes de que la imagen trajera el script no lo tiene.
    // Se dice claro para que quien lo pidió siga sin esto en vez de pelearse.
    if (/Cannot find module|ERR_MODULE_NOT_FOUND|No such file/i.test(r.stderr)) {
      return { ok: false, error: "esta sala todavía no tiene navegador (se activa cuando la sala se reinicia)" };
    }
    return { ok: false, error: (r.stderr || r.stdout).trim().split("\n")[0]?.slice(0, 300) || "el navegador no contestó" };
  }
}

/** Lo que ve `ver_preview`. Una captura de 1280×2400 en JPEG ronda el MB en base64. */
export function capturarPreview(runner: Runner, base: string, pedido: PedidoDeCaptura): Promise<Captura> {
  return correr<Captura>(
    runner,
    "capturar.mjs",
    { url: base + pedido.ruta, ancho: pedido.ancho, alto: pedido.alto, completa: pedido.completa },
    { timeoutMs: 50_000, maxOutput: 8 * 1024 * 1024 },
  );
}

export type FormatoDePresentacion = "pdf" | "pptx";

export type Exportacion =
  | { ok: true; archivo: string; diapositivas: number; titulo: string }
  | { ok: false; error: string };

/**
 * La presentación de la vista previa como PDF o PowerPoint (ver exportar.mjs).
 * Un PowerPoint de 70 diapositivas con fotos pasa de los 30 MB en base64.
 */
export function exportarPresentacion(
  runner: Runner,
  base: string,
  formato: FormatoDePresentacion,
): Promise<Exportacion> {
  return correr<Exportacion>(runner, "exportar.mjs", { url: `${base}/`, formato }, {
    timeoutMs: 120_000,
    maxOutput: 96 * 1024 * 1024,
  });
}
