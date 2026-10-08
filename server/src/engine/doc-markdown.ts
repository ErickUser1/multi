import { createHash, randomBytes } from "node:crypto";
import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import {
  MarkdownParser,
  MarkdownSerializer,
  defaultMarkdownSerializer,
  type MarkdownSerializerState,
} from "prosemirror-markdown";
import { getSchema, type JSONContent } from "@tiptap/core";
import type { Node as PMNode, Schema } from "@tiptap/pm/model";
import { extensionesDelDocumento } from "./doc-esquema.js";

/**
 * Markdown ⇄ bloques del documento.
 *
 * El documento NO es markdown: es un árbol de bloques (ver doc-esquema.ts) que
 * vive en Yjs. El markdown es solo el idioma del agente: lo que escribe entra
 * por aquí y se vuelve bloques, una sola vez; lo que lee sale de los bloques.
 * Las personas editan el árbol directo y nunca pasan por esta conversión, así
 * que abrir y guardar no reescribe nada.
 *
 * Lo que el parser no reconoce NUNCA se tira: se queda como texto. Un bloque que
 * el agente escribió raro se ve raro, pero no desaparece.
 */

/** Una gráfica o un diagrama. En el texto solo queda un nodo con su `ref`. */
export interface ObjetoDelDocumento {
  tipo: "grafica" | "diagrama";
  /** El JSON de la gráfica o el SVG del diagrama, tal como se escribió. */
  fuente: string;
}

export type Objetos = Record<string, ObjetoDelDocumento>;

let esquema: Schema | null = null;
/** El esquema compartido con el navegador. Se arma una vez: getSchema no es barato. */
export function esquemaDelDocumento(): Schema {
  return (esquema ??= getSchema(extensionesDelDocumento()));
}

/** Un id corto para bloques y objetos. No tiene que ser global, solo único en el documento. */
export function nuevoId(): string {
  return randomBytes(6).toString("base64url");
}

const PENDIENTE = /^<!--\s*pendiente:\s*([\s\S]*?)\s*-->\s*$/;

const md = new MarkdownIt({ html: true, linkify: false });

/**
 * Ajusta los tokens de markdown-it a lo que el esquema entiende, antes de que
 * prosemirror-markdown los convierta:
 * - ```grafica / ```diagrama → objeto aparte + nodo con su ref.
 * - <!-- pendiente: … --> → nodo pendiente. Cualquier otro HTML → texto tal cual.
 * - Un párrafo que solo trae imágenes → bloques de imagen.
 * - Tablas: sin thead/tbody, y con un párrafo dentro de cada celda.
 */
function ajustarTokens(tokens: Token[], objetos: Objetos): Token[] {
  const T = tokens[0]?.constructor as (new (type: string, tag: string, nesting: number) => Token) | undefined;
  if (!T) return tokens;
  const texto = (contenido: string): Token[] => {
    const abre = new T("paragraph_open", "p", 1);
    const inline = new T("inline", "", 0);
    const t = new T("text", "", 0);
    t.content = contenido;
    inline.children = [t];
    inline.content = contenido;
    return [abre, inline, new T("paragraph_close", "p", -1)];
  };
  const objeto = (tipo: ObjetoDelDocumento["tipo"], fuente: string): Token => {
    const id = nuevoId();
    objetos[id] = { tipo, fuente: fuente.replace(/\n$/, "") };
    const tok = new T(tipo, "", 0);
    tok.attrSet("ref", id);
    return tok;
  };

  const salida: Token[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];

    if (tok.type === "fence") {
      const lenguaje = tok.info.trim().split(/\s+/)[0];
      if (lenguaje === "grafica" || lenguaje === "diagrama") {
        salida.push(objeto(lenguaje, tok.content));
        continue;
      }
    }

    if (tok.type === "html_block") {
      const m = tok.content.trim().match(PENDIENTE);
      if (m) {
        const p = new T("pendiente", "", 0);
        p.attrSet("intencion", m[1]);
        salida.push(p);
      } else {
        salida.push(...texto(tok.content.replace(/\n$/, "")));
      }
      continue;
    }

    if (tok.type === "thead_open" || tok.type === "thead_close" || tok.type === "tbody_open" || tok.type === "tbody_close") {
      continue;
    }

    if ((tok.type === "th_open" || tok.type === "td_open") && tokens[i + 1]?.type === "inline") {
      salida.push(tok, new T("paragraph_open", "p", 1), tokens[i + 1], new T("paragraph_close", "p", -1));
      i++;
      continue;
    }

    if (tok.type === "inline" && tok.children) {
      tok.children = tok.children.map((c) => {
        if (c.type !== "html_inline") return c;
        const t = new T("text", "", 0);
        t.content = c.content;
        return t;
      });
    }

    // Un párrafo con solo imágenes: cada una se vuelve su propio bloque.
    if (tok.type === "paragraph_open" && tokens[i + 1]?.type === "inline" && tokens[i + 2]?.type === "paragraph_close") {
      const hijos = tokens[i + 1].children ?? [];
      const imagenes = hijos.filter((c) => c.type === "image");
      const resto = hijos.filter((c) => c.type !== "image" && !(c.type === "text" && !c.content.trim()) && c.type !== "softbreak");
      if (imagenes.length > 0 && resto.length === 0) {
        for (const img of imagenes) {
          const b = new T("imagen", "", 0);
          b.attrSet("src", img.attrGet("src") ?? "");
          b.attrSet("alt", img.content || "");
          salida.push(b);
        }
        i += 2;
        continue;
      }
      // Imágenes en medio del texto: se quedan como su markdown, para no perderlas.
      if (imagenes.length > 0) {
        tokens[i + 1].children = hijos.map((c) => {
          if (c.type !== "image") return c;
          const t = new T("text", "", 0);
          t.content = `![${c.content}](${c.attrGet("src") ?? ""})`;
          return t;
        });
      }
    }

    salida.push(tok);
  }
  return salida;
}

function parser(objetos: Objetos): MarkdownParser {
  const atributo = (nombre: string) => (tok: Token) => tok.attrGet(nombre) ?? "";
  return new MarkdownParser(
    esquemaDelDocumento(),
    // El tokenizador es el de markdown-it más el ajuste de arriba. Los tipos de
    // markdown-it y de @types/markdown-it no coinciden en detalles; el objeto
    // es el mismo.
    { parse: (src: string, env: never) => ajustarTokens(md.parse(src, env) as never, objetos) } as never,
    {
      blockquote: { block: "blockquote" },
      paragraph: { block: "paragraph" },
      list_item: { block: "listItem" },
      bullet_list: { block: "bulletList" },
      ordered_list: { block: "orderedList", getAttrs: (tok) => ({ start: Number(tok.attrGet("start")) || 1 }) },
      heading: { block: "heading", getAttrs: (tok) => ({ level: Math.min(3, Number(tok.tag.slice(1)) || 1) }) },
      code_block: { block: "codeBlock", noCloseToken: true },
      fence: { block: "codeBlock", getAttrs: (tok) => ({ language: tok.info.trim() || null }), noCloseToken: true },
      hr: { node: "horizontalRule" },
      hardbreak: { node: "hardBreak" },
      table: { block: "table" },
      tr: { block: "tableRow" },
      th: { block: "tableHeader" },
      td: { block: "tableCell" },
      grafica: { node: "grafica", getAttrs: (tok) => ({ ref: atributo("ref")(tok) }) },
      diagrama: { node: "diagrama", getAttrs: (tok) => ({ ref: atributo("ref")(tok) }) },
      pendiente: { node: "pendiente", getAttrs: (tok) => ({ intencion: atributo("intencion")(tok) }) },
      imagen: { node: "imagen", getAttrs: (tok) => ({ src: atributo("src")(tok), alt: atributo("alt")(tok) }) },
      em: { mark: "italic" },
      strong: { mark: "bold" },
      s: { mark: "strike" },
      link: { mark: "link", getAttrs: (tok) => ({ href: tok.attrGet("href"), title: tok.attrGet("title") || null }) },
      code_inline: { mark: "code", noCloseToken: true },
    },
  );
}

/**
 * Markdown → bloques (los hijos del documento) y los objetos que trajo
 * (gráficas y diagramas). Un markdown vacío da cero bloques.
 */
export function markdownABloques(markdown: string): { bloques: JSONContent[]; objetos: Objetos } {
  const objetos: Objetos = {};
  const doc = parser(objetos).parse(markdown);
  const json = doc.toJSON() as JSONContent;
  return { bloques: json.content ?? [], objetos };
}

// ── Bloques → markdown ──────────────────────────────────────────────────────

function serializer(objetos: Objetos): MarkdownSerializer {
  const d = defaultMarkdownSerializer;
  const fence = (state: MarkdownSerializerState, lenguaje: string, contenido: string, node: PMNode) => {
    // Una cerca más larga que cualquier ``` de adentro, para que el contenido no la cierre.
    const largo = Math.max(3, ...(contenido.match(/`{3,}/g) ?? []).map((m) => m.length + 1));
    const cerca = "`".repeat(largo);
    state.write(`${cerca}${lenguaje}\n`);
    state.text(contenido, false);
    state.ensureNewLine();
    state.write(cerca);
    state.closeBlock(node);
  };
  const celda = (node: PMNode): string =>
    porBloque(node, (p) => sOne.serialize(esquemaDelDocumento().node("doc", null, [p])))
      .join(" ")
      .replace(/\n+/g, " ")
      .replace(/\|/g, "\\|")
      .trim();

  const sOne: MarkdownSerializer = new MarkdownSerializer(
    {
      blockquote: d.nodes.blockquote,
      paragraph: d.nodes.paragraph,
      text: d.nodes.text,
      horizontalRule: d.nodes.horizontal_rule,
      hardBreak: d.nodes.hard_break,
      heading(state, node) {
        state.write(`${state.repeat("#", node.attrs.level)} `);
        state.renderInline(node, false);
        state.closeBlock(node);
      },
      codeBlock(state, node) {
        fence(state, node.attrs.language ?? "", node.textContent, node);
      },
      bulletList(state, node) {
        state.renderList(node, "  ", () => "- ");
      },
      orderedList(state, node) {
        const inicio = node.attrs.start ?? 1;
        const ancho = String(inicio + node.childCount - 1).length;
        state.renderList(node, state.repeat(" ", ancho + 2), (i) => {
          const n = String(inicio + i);
          return `${state.repeat(" ", ancho - n.length)}${n}. `;
        });
      },
      listItem(state, node) {
        state.renderContent(node);
      },
      imagen(state, node) {
        state.write(`![${state.esc(node.attrs.alt || "")}](${String(node.attrs.src).replace(/[()]/g, "\\$&")})`);
        state.closeBlock(node);
      },
      grafica(state, node) {
        fence(state, "grafica", objetos[node.attrs.ref]?.fuente ?? "", node);
      },
      diagrama(state, node) {
        fence(state, "diagrama", objetos[node.attrs.ref]?.fuente ?? "", node);
      },
      pendiente(state, node) {
        state.write(`<!-- pendiente: ${String(node.attrs.intencion).replace(/-->/g, "—")} -->`);
        state.closeBlock(node);
      },
      table(state, node) {
        const filas: string[][] = [];
        node.forEach((fila) => {
          const celdas: string[] = [];
          fila.forEach((c) => celdas.push(celda(c)));
          filas.push(celdas);
        });
        const columnas = Math.max(1, ...filas.map((f) => f.length));
        const linea = (f: string[]) => `| ${Array.from({ length: columnas }, (_, i) => f[i] ?? "").join(" | ")} |`;
        const [cabeza = [], ...cuerpo] = filas;
        state.write([linea(cabeza), `|${" --- |".repeat(columnas)}`, ...cuerpo.map(linea)].join("\n"));
        state.closeBlock(node);
      },
      tableRow() {},
      tableHeader() {},
      tableCell() {},
    },
    {
      italic: d.marks.em,
      bold: d.marks.strong,
      code: d.marks.code,
      link: d.marks.link,
      strike: { open: "~~", close: "~~", mixable: true, expelEnclosingWhitespace: true },
    },
    // `tightLists` existe en el serializer aunque sus tipos no lo declaren:
    // listas sin línea en blanco entre items, como las escribe todo mundo.
    { hardBreakNodeName: "hardBreak", tightLists: true } as never,
  );
  return sOne;
}

function porBloque<T>(node: PMNode, f: (hijo: PMNode) => T): T[] {
  const r: T[] = [];
  node.forEach((h) => r.push(f(h)));
  return r;
}

/** La huella de un bloque: cambia si cambia cualquier cosa de él, sus objetos incluidos. */
export function hashDeBloque(bloque: JSONContent, objetos: Objetos): string {
  const h = createHash("sha1").update(JSON.stringify(bloque));
  const ref = bloque.attrs?.ref;
  if (typeof ref === "string" && objetos[ref]) h.update(objetos[ref].fuente);
  return h.digest("hex").slice(0, 8);
}

/** Un bloque en markdown, sin salto final. */
export function bloqueAMarkdown(bloque: JSONContent, objetos: Objetos): string {
  const s = esquemaDelDocumento();
  return serializer(objetos).serialize(s.node("doc", null, [s.nodeFromJSON(bloque)])).trim();
}

/**
 * Bloques → markdown.
 *
 * Con `ids` (uno por bloque, en orden), cada bloque sale precedido de
 * `⟦id·hash⟧`: es lo que el agente cita para cambiar uno solo. Sin ids es la
 * exportación legible.
 */
export function bloquesAMarkdown(bloques: JSONContent[], objetos: Objetos, opts: { ids?: string[] } = {}): string {
  return bloques
    .map((b, i) => {
      const texto = bloqueAMarkdown(b, objetos);
      return opts.ids ? `⟦${opts.ids[i] ?? "?"}·${hashDeBloque(b, objetos)}⟧\n${texto}` : texto;
    })
    .join("\n\n");
}
