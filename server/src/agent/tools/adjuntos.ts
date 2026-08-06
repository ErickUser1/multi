import { copyFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { type Tool, ToolError, safePath, reqString } from "./base.js";
import { listarAdjuntos, rutaAdjunto, nombreDe } from "../../engine/adjuntos.js";

/**
 * Meter al proyecto una imagen que alguien pegó en el chat.
 *
 * Las imágenes del chat viven FUERA del workspace, porque la mayoría son plática
 * y no tienen por qué acabar en el repo. Esta tool es la puerta por la que entran
 * las que sí se van a usar.
 *
 * La decisión es del agente a propósito. Él es quien sabe dónde van los estáticos
 * de su stack: `public/` en Vite y en Next, `src/assets/` en Astro. El motor no lo
 * impone, igual que no impone el stack.
 *
 * También resuelve un detalle práctico: `read_file` lee utf8, así que un PNG leído
 * por ahí sale como basura. Aquí el agente no lee la imagen, pide que se copie.
 */
export const usarAdjuntoTool: Tool = {
  spec: {
    name: "usar_adjunto",
    description:
      "Copia al proyecto una imagen que alguien adjuntó en el chat, para poder usarla en la app. " +
      "El adjunto se identifica por el nombre con el que aparece en el mensaje. " +
      "Elige tú el destino según tu stack (public/ en Vite y Next, src/assets/ en Astro).",
    input_schema: {
      type: "object",
      properties: {
        adjunto: {
          type: "string",
          description: "Nombre del adjunto tal como aparece en el chat, ej. logo.png",
        },
        destino: {
          type: "string",
          description: "Ruta relativa dentro del proyecto donde dejarlo, ej. public/logo.png",
        },
      },
      required: ["adjunto", "destino"],
    },
  },
  async run(input, ctx) {
    const pedido = reqString(input, "adjunto");
    const destinoRel = reqString(input, "destino");

    // safePath es la misma muralla que usan write y edit: nada de rutas absolutas
    // ni de salirse del workspace con "..".
    const destino = safePath(ctx.workspaceDir, destinoRel);

    const origen = await resolverAdjunto(ctx.workspaceDir, pedido);
    if (!origen) {
      const hay = await listarAdjuntos(ctx.workspaceDir);
      throw new ToolError(
        hay.length
          ? `no encuentro el adjunto "${pedido}". Los que hay en esta sala: ` +
            hay.map((f) => `${nombreDe(f)} (id: ${f})`).join(", ")
          : `no encuentro el adjunto "${pedido}". Nadie ha adjuntado imágenes en esta sala.`,
      );
    }

    await mkdir(dirname(destino), { recursive: true });
    await copyFile(origen, destino);

    // Que el preview lo recoja igual que si lo hubiera escrito write_file.
    ctx.emit?.({ type: "file:changed", path: destinoRel, action: "write" });
    return `copiado a ${destinoRel}. Ya puedes referenciarlo desde el código.`;
  },
};

/**
 * Encuentra el adjunto por lo que el agente escribió.
 *
 * El camino normal es el id: el mensaje se lo da hecho ("usar_adjunto(<id>, …)")
 * justamente para que no tenga que adivinar. En disco los adjuntos son UUIDs para
 * que ningún nombre venido de fuera decida dónde se escribe.
 *
 * Lo demás es respaldo por si el agente escribe el nombre visible en vez del id.
 * Solo desempata cuando NO hay ambigüedad: con dos imágenes del mismo tipo,
 * elegir una sería copiar la equivocada la mitad de las veces, y es mejor decirlo.
 */
async function resolverAdjunto(workspaceDir: string, pedido: string): Promise<string | null> {
  const directo = await rutaAdjunto(workspaceDir, pedido);
  if (directo) return directo;

  // Por el nombre con el que se subió. Se compara contra el nombre real, no
  // contra la extensión: pedir "noexiste.png" cuando solo hay "logo.png" tiene
  // que fallar, no copiar el logo por ser el único PNG.
  const hay = await listarAdjuntos(workspaceDir);
  const buscado = pedido.toLowerCase();
  const candidatos = hay.filter((f) => nombreDe(f).toLowerCase() === buscado);

  // Uno solo: no hay nada que adivinar. Varios con el mismo nombre: que lo diga
  // con el id, y el mensaje de error los lista.
  return candidatos.length === 1 ? rutaAdjunto(workspaceDir, candidatos[0]) : null;
}
