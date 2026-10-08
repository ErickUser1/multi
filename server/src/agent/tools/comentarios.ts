import { type Tool, ToolError, reqString, optString } from "./base.js";

/**
 * Lo que el agente puede hacer con los comentarios del documento: contestar en
 * un hilo, o abrir uno nuevo sobre una frase (una duda, un dato que falta).
 * Capacidad inyectada, como el documento: la tool no sabe de salas ni de la base.
 */
export interface OperacionesDeComentarios {
  responder(hilo: string, texto: string): Promise<string>;
  nuevo(bloque: string, cita: string, texto: string): Promise<string>;
}

export const comentarTool: Tool = {
  spec: {
    name: "comentar",
    description:
      "Comenta en el documento. Para CONTESTAR un comentario, manda `hilo` (el id que viene en el pedido) y tu respuesta: " +
      "si el pedido vino de un comentario, contesta SOLO ahí, no en el chat. Para abrir un comentario nuevo sobre una " +
      "frase (una duda, un dato que falta, algo que alguien tiene que decidir), manda `bloque` (id de leer_documento), " +
      "`cita` (el texto exacto del bloque al que se refiere, corto) y el texto. Sé breve, como en Google Docs.",
    input_schema: {
      type: "object",
      properties: {
        texto: { type: "string" },
        hilo: { type: "string", description: "id del hilo para contestar" },
        bloque: { type: "string", description: "id del bloque, para un comentario nuevo" },
        cita: { type: "string", description: "texto exacto del bloque, para un comentario nuevo" },
      },
      required: ["texto"],
    },
  },
  async run(input, ctx) {
    if (!ctx.comentarios) throw new ToolError("aquí no hay documento para comentar");
    const texto = reqString(input, "texto").trim();
    if (!texto) throw new ToolError("el comentario llegó vacío");
    const hilo = optString(input, "hilo");
    if (hilo) return ctx.comentarios.responder(hilo, texto);
    const bloque = optString(input, "bloque");
    const cita = optString(input, "cita");
    if (!bloque || !cita) throw new ToolError("para un comentario nuevo hacen falta `bloque` y `cita`; para contestar, `hilo`");
    return ctx.comentarios.nuevo(bloque, cita, texto);
  },
};
