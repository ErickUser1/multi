import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
import { graficaSvg } from "./grafica";
import { diagramaSeguro } from "./svg-seguro";

/**
 * Markdown → HTML para el documento, con lo que Multi le agrega: gráficas y
 * diagramas en bloques de código, e imágenes que viven en la sala.
 *
 * Todo lo que sale de aquí lo escribió un modelo (o alguien de la sala) y se
 * mete con innerHTML, así que hay tres muros:
 * - markdown-it con `html: false`: el HTML crudo del markdown se escapa.
 * - Los diagramas (SVG que dibuja el agente) pasan por DOMPurify con el perfil
 *   de SVG y sin lo que puede cargar o ejecutar algo.
 * - El HTML final pasa OTRA vez por DOMPurify. Si algo se coló por una regla
 *   de aquí, ahí se cae.
 */

export function crearRenderer(urlImagen: (nombre: string) => string): (md: string) => string {
  const md = new MarkdownIt({ html: false, linkify: true, typographer: true, breaks: false });

  const fenceOriginal = md.renderer.rules.fence!;
  md.renderer.rules.fence = (tokens, idx, opts, env, self) => {
    const token = tokens[idx];
    const lenguaje = token.info.trim().split(/\s+/)[0];
    if (lenguaje === "grafica") {
      const svg = graficaSvg(token.content);
      return svg
        ? `<figure class="doc-grafica">${svg}</figure>`
        : `<div class="doc-aviso">No se pudo dibujar esta gráfica.</div>`;
    }
    if (lenguaje === "diagrama") {
      const svg = diagramaSeguro(token.content);
      return svg
        ? `<figure class="doc-diagrama">${svg}</figure>`
        : `<div class="doc-aviso">No se pudo dibujar este diagrama.</div>`;
    }
    return fenceOriginal(tokens, idx, opts, env, self);
  };

  // Las imágenes del documento se escriben como "imagenes/x.png": se sirven
  // desde la sala. Las de internet (https) pasan tal cual; lo demás se quita.
  const imagenOriginal = md.renderer.rules.image!;
  md.renderer.rules.image = (tokens, idx, opts, env, self) => {
    const token = tokens[idx];
    const src = String(token.attrGet("src") ?? "");
    const local = src.replace(/^\.?\//, "").match(/^(?:documento\/)?imagenes\/([^/?#]+)$/);
    if (local) token.attrSet("src", urlImagen(local[1]));
    else if (!/^https:\/\//i.test(src)) return "";
    token.attrSet("loading", "lazy");
    return imagenOriginal(tokens, idx, opts, env, self);
  };

  // Los enlaces abren aparte: un clic no debe sacar a nadie de la sala.
  const linkOriginal =
    md.renderer.rules.link_open ?? ((tokens, idx, opts, _env, self) => self.renderToken(tokens, idx, opts));
  md.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
    tokens[idx].attrSet("target", "_blank");
    tokens[idx].attrSet("rel", "noopener noreferrer");
    return linkOriginal(tokens, idx, opts, env, self);
  };

  return (texto: string) =>
    DOMPurify.sanitize(md.render(texto), {
      ADD_ATTR: ["target"],
      FORBID_TAGS: ["script", "style", "iframe", "foreignObject", "use"],
    });
}
