import DOMPurify from "dompurify";

/**
 * El SVG de un diagrama, sin lo que puede cargar o ejecutar algo.
 *
 * Lo dibujó un modelo (o alguien de la sala) y se mete con innerHTML: perfil de
 * SVG de DOMPurify, sin scripts, sin enlaces, sin imágenes externas y sin
 * estilos. Vacío si lo que queda no es un SVG.
 */
const SVG_PROHIBIDO = {
  USE_PROFILES: { svg: true, svgFilters: true },
  FORBID_TAGS: ["script", "foreignObject", "image", "use", "a", "style", "iframe", "animate", "set"],
  FORBID_ATTR: ["href", "xlink:href", "style"],
};

export function diagramaSeguro(svg: string): string {
  const limpio = DOMPurify.sanitize(svg, SVG_PROHIBIDO);
  return limpio.trim().startsWith("<svg") ? limpio : "";
}
