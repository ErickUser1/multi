import { type Tool, type ToolContext, type ResultadoConImagen, ToolError } from "./base.js";

/**
 * Ver la vista previa como la ve la gente: un navegador de verdad, una captura
 * y los errores que salieron.
 *
 * Por qué existe: en todas las sesiones con gente real el agente decía "listo"
 * sin haber visto nada. Un `main.tsx` que importaba un `App.tsx` que nunca se
 * escribió, una pantalla en blanco, el error rojo de Vite: lo descubría la
 * persona, y a veces ahí dejaba Multi. El agente solo tenía archivos y bash.
 *
 * Quien abre el navegador es la sala (`ctx.verPreview`), dentro de su
 * contenedor. Esta tool solo decide qué pedir y cómo contarle al modelo lo que
 * salió.
 */

export interface PedidoDeCaptura {
  /** La ruta dentro del proyecto, empezando con "/". */
  ruta: string;
  ancho: number;
  alto: number;
  /** Toda la página hacia abajo (con tope) y no solo lo que cabe en pantalla. */
  completa: boolean;
}

export type Captura =
  | {
      ok: true;
      titulo: string;
      enBlanco: boolean;
      overlay: string;
      errores: string[];
      alto: number;
      altoTotal: number;
      /** JPEG en base64. */
      imagen: string;
    }
  | { ok: false; error: string; errores?: string[] };

export const DISPOSITIVOS = {
  compu: { ancho: 1280, alto: 800 },
  celular: { ancho: 390, alto: 844 },
} as const;

/**
 * Cuántas capturas por turno. Cada una cuesta lo de una imagen (~1,500 tokens),
 * y un agente que no logra arreglar algo puede quedarse mirando en bucle.
 */
export const MAX_CAPTURAS_POR_TURNO = 4;

/** Capturas hechas, por turno. El ToolContext es uno por turno, así que es la llave natural. */
const capturasDelTurno = new WeakMap<ToolContext, number>();

export const verPreviewTool: Tool<ResultadoConImagen> = {
  spec: {
    name: "ver_preview",
    description:
      "Abre la vista previa de la sala en un navegador y te devuelve una captura de cómo se ve, " +
      "más los errores de la consola, las excepciones, lo que no cargó y el error de compilación " +
      "si lo hay. Úsalo después de cambiar algo que se ve y ANTES de decir que quedó. Si hay " +
      "errores o sale en blanco, arréglalo y vuelve a mirar. " +
      `Máximo ${MAX_CAPTURAS_POR_TURNO} por turno: no lo uses si no tocaste nada visual.`,
    input_schema: {
      type: "object",
      properties: {
        ruta: {
          type: "string",
          description: 'Opcional. La página a abrir, ej. "/carrito". Por omisión, la principal ("/").',
        },
        dispositivo: {
          type: "string",
          enum: ["compu", "celular"],
          description: 'Opcional. "compu" (1280×800, por omisión) o "celular" (390×844).',
        },
        completa: {
          type: "boolean",
          description: "Opcional. true para toda la página hacia abajo y no solo la primera pantalla.",
        },
      },
    },
  },
  async run(input, ctx) {
    if (!ctx.verPreview) {
      throw new ToolError("aquí no hay vista previa que mirar. Sigue sin esto.");
    }
    const hechas = capturasDelTurno.get(ctx) ?? 0;
    if (hechas >= MAX_CAPTURAS_POR_TURNO) {
      throw new ToolError(
        `ya miraste la vista previa ${MAX_CAPTURAS_POR_TURNO} veces en este turno. No la vuelvas a pedir: ` +
          "di en el chat qué quedó y qué sigue fallando, si algo.",
      );
    }

    const dispositivo = input.dispositivo === "celular" ? "celular" : "compu";
    const pedido: PedidoDeCaptura = {
      ruta: normalizarRuta(input.ruta),
      ...DISPOSITIVOS[dispositivo],
      completa: input.completa === true,
    };

    capturasDelTurno.set(ctx, hechas + 1);
    const captura = await ctx.verPreview(pedido);
    if (!captura) {
      throw new ToolError(
        "no hay vista previa corriendo. Si el proyecto tiene interfaz, revisa que el script \"dev\" de " +
          "package.json arranque; si es solo backend, no hace falta mirar.",
      );
    }
    if (!captura.ok) {
      const errores = captura.errores?.length ? `\n${listar(captura.errores)}` : "";
      throw new ToolError(`no se pudo ver la vista previa: ${captura.error}${errores}`);
    }

    return {
      texto: describir(captura, pedido, dispositivo),
      imagen: { mediaType: "image/jpeg", data: captura.imagen },
    };
  },
};

function normalizarRuta(v: unknown): string {
  const ruta = typeof v === "string" ? v.trim() : "";
  if (!ruta) return "/";
  // Una URL entera no: siempre es la vista previa de esta sala.
  if (/^[a-z]+:\/\//i.test(ruta)) {
    throw new ToolError('ruta es la página dentro del proyecto, como "/carrito", no una URL.');
  }
  return ruta.startsWith("/") ? ruta : `/${ruta}`;
}

/** Lo que el modelo lee junto a la captura. Lo malo primero: es lo que tiene que atender. */
export function describir(
  c: Extract<Captura, { ok: true }>,
  pedido: PedidoDeCaptura,
  dispositivo: string,
): string {
  const lineas = [`vista previa de ${pedido.ruta} en ${dispositivo} (${pedido.ancho}×${pedido.alto})`];
  if (c.overlay) lineas.push(`ERROR DE COMPILACIÓN en pantalla:\n${c.overlay}`);
  if (c.enBlanco) lineas.push("SE VE EN BLANCO: la página no muestra nada.");
  if (c.errores.length) lineas.push(`errores (${c.errores.length}):\n${listar(c.errores)}`);
  if (!c.overlay && !c.enBlanco && c.errores.length === 0) lineas.push("sin errores en la consola.");
  if (c.titulo) lineas.push(`título: ${c.titulo}`);
  if (!pedido.completa && c.altoTotal > pedido.alto * 1.2) {
    lineas.push(`la página mide ${c.altoTotal}px de alto; la captura es solo la primera pantalla (completa: true para el resto).`);
  }
  return lineas.join("\n");
}

function listar(errores: string[]): string {
  return errores.map((e) => `- ${e}`).join("\n");
}
