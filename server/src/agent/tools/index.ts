import { type CualquierTool } from "./base.js";
import { fsTools } from "./fs.js";
import { bashTool } from "./bash.js";
import { usarAdjuntoTool } from "./adjuntos.js";
import { sqlTool } from "./sql.js";
import { verBaseTool } from "./ver-base.js";
import { documentoTools } from "./documento.js";
import { comentarTool } from "./comentarios.js";
import { verPreviewTool } from "./ver-preview.js";

export * from "./base.js";

/** Todas las tools del agente. */
export const allTools: CualquierTool[] = [
  ...fsTools,
  bashTool,
  usarAdjuntoTool,
  sqlTool,
  verBaseTool,
  ...documentoTools,
  comentarTool,
  verPreviewTool,
];

/** Registro por nombre, para despachar los tool_use. */
export const toolRegistry = new Map<string, CualquierTool>(allTools.map((t) => [t.spec.name, t]));

/** Specs para pasar al modelo. */
export const toolSpecs = allTools.map((t) => t.spec);
