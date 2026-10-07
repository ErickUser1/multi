import { type Tool, ToolError, safePath, reqString } from "./base.js";
import { fileMutation } from "../../engine/file-mutation.js";
import { archivosDelEsqueleto, esDocumento, type SeccionNueva } from "../../engine/documento.js";
import { detectLaunch } from "../../engine/preview.js";

/**
 * Convierte la sala en un documento y deja el esqueleto listo para llenarse.
 *
 * La sala nace sin tipo. Quien decide si es software o documento es el agente,
 * con el primer pedido: nadie tiene que escoger entre botones que no entiende.
 * Que la decisión sea una tool y no algo que el modelo "piense" la deja
 * registrada: Multi sabe cuándo cambió y lo avisa a la sala.
 *
 * El esqueleto va primero y vacío a propósito: el título y una sección pendiente
 * por parte, cada una con lo que va a llevar. Quien mira ve el documento
 * llenarse, y si hay varios agentes cada uno toma una sección distinta.
 */
export const iniciarDocumentoTool: Tool = {
  spec: {
    name: "iniciar_documento",
    description:
      "Convierte la sala en un DOCUMENTO (ensayo, reporte, propuesta, manual, plan, investigación…) y crea su esqueleto: " +
      "el título y una sección pendiente por cada parte, con lo que va a llevar. Multi pinta el documento en el panel " +
      "de la sala y lo exporta; no hace falta crear ningún proyecto web. Úsala UNA vez, al empezar, y solo si la sala " +
      "no tiene proyecto. Después escribe cada sección reemplazando su archivo en documento/secciones/.",
    input_schema: {
      type: "object",
      properties: {
        titulo: { type: "string", description: "Título del documento" },
        secciones: {
          type: "array",
          description: "Las partes del documento, en orden",
          items: {
            type: "object",
            properties: {
              titulo: { type: "string", description: "Encabezado de la sección" },
              intencion: { type: "string", description: "Qué va a decir, en una línea" },
            },
            required: ["titulo", "intencion"],
          },
        },
      },
      required: ["titulo", "secciones"],
    },
  },
  async run(input, ctx) {
    const titulo = reqString(input, "titulo");
    const crudas = Array.isArray(input.secciones) ? input.secciones : [];
    const secciones: SeccionNueva[] = crudas
      .map((s) => s as { titulo?: unknown; intencion?: unknown })
      .filter((s) => typeof s.titulo === "string" && s.titulo.trim())
      .map((s) => ({ titulo: String(s.titulo), intencion: typeof s.intencion === "string" ? s.intencion : "" }));
    if (secciones.length === 0) throw new ToolError("hace falta al menos una sección con título");
    if (secciones.length > 40) throw new ToolError("son demasiadas secciones; agrupa en 40 o menos");

    if (esDocumento(ctx.workspaceDir)) {
      throw new ToolError(
        "esta sala ya es un documento: lee documento/documento.json y escribe en documento/secciones/ en vez de empezar otro",
      );
    }
    if ((await detectLaunch(ctx.workspaceDir)) !== null) {
      throw new ToolError(
        "esta sala ya tiene un proyecto de software; un documento no cabe aquí. Si lo que piden es un documento, sugiere abrir una sala nueva",
      );
    }

    const archivos = archivosDelEsqueleto(titulo, secciones);
    for (const a of archivos) {
      // Condicional con `expected: null`: solo se crea si no existe. Si otro
      // agente empezó un documento al mismo tiempo, el segundo falla aquí en vez
      // de pisarle el esqueleto.
      await fileMutation.writeIfUnchanged({
        path: safePath(ctx.workspaceDir, a.ruta),
        content: a.contenido,
        expected: null,
        agentId: ctx.agentId ?? "agente",
      });
      ctx.emit?.({ type: "file:changed", path: a.ruta, action: "write" });
    }

    const lista = archivos
      .slice(1)
      .map((a) => `- ${a.ruta}`)
      .join("\n");
    return (
      `documento iniciado: "${titulo}" con ${secciones.length} secciones pendientes. ` +
      `Ahora escribe cada una reemplazando su archivo completo (write_file), empezando por "## Título":\n${lista}`
    );
  },
};
