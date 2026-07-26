import { type Tool } from "./base.js";
import { fsTools } from "./fs.js";
import { bashTool } from "./bash.js";

export * from "./base.js";

/** Todas las tools del agente. */
export const allTools: Tool[] = [...fsTools, bashTool];

/** Registro por nombre, para despachar los tool_use. */
export const toolRegistry = new Map<string, Tool>(allTools.map((t) => [t.spec.name, t]));

/** Specs para pasar al modelo. */
export const toolSpecs = allTools.map((t) => t.spec);
