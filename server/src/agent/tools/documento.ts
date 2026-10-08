import type { JSONContent } from "@tiptap/core";
import { type Tool, ToolError, reqString, optString } from "./base.js";
import { detectLaunch } from "../../engine/preview.js";
import { esDocumento, CARPETA_DOCUMENTO, ARCHIVO_MD } from "../../engine/documento.js";
import {
  documentosVivos,
  estado,
  aplicar,
  cambiarObjeto,
  textoDe,
  type DocVivo,
  type Origen,
} from "../../engine/doc-vivo.js";
import { markdownABloques, bloquesAMarkdown, hashDeBloque, type Objetos } from "../../engine/doc-markdown.js";
import { createHash } from "node:crypto";

/**
 * Lo que el agente puede hacerle al documento de su sala.
 *
 * Se inyecta como capacidad (igual que ejecutarSql): las tools no saben de
 * salas ni de sockets, reciben lo que pueden hacer. Quien no la recibe (un demo
 * sin sala) obtiene un error que lo dice.
 *
 * Cada cambio lleva la huella (hash) del bloque o la sección que el agente leyó.
 * Si alguien lo cambió mientras tanto (una persona escribiendo, otro agente),
 * se rechaza: es la escritura condicional de siempre, a nivel de bloque.
 */
export interface OperacionesDeDocumento {
  existe(): boolean;
  iniciar(titulo: string, secciones: { titulo: string; intencion: string }[]): Promise<string>;
  leer(seccion?: string): Promise<string>;
  escribirSeccion(seccion: string, hash: string, markdown: string): Promise<string>;
  reemplazarBloque(id: string, hash: string, markdown: string): Promise<string>;
  insertarBloques(despuesDe: string, markdown: string): Promise<string>;
  borrarBloque(id: string, hash: string): Promise<string>;
  moverSeccion(seccion: string, antesDe: string | null): Promise<string>;
  cambiarObjeto(id: string, hash: string, fuente: string): Promise<string>;
}

const esTitulo = (b: JSONContent) => b.type === "heading";
const nivel = (b: JSONContent) => Number(b.attrs?.level ?? 9);

/** Dónde empieza y termina una sección: su título y lo que sigue hasta el siguiente del mismo nivel o mayor. */
function rangoDeSeccion(bloques: JSONContent[], id: string): [number, number] | null {
  const i = bloques.findIndex((b) => b.attrs?.id === id);
  if (i < 0 || !esTitulo(bloques[i])) return null;
  const n = nivel(bloques[i]);
  let j = i + 1;
  while (j < bloques.length && !(esTitulo(bloques[j]) && nivel(bloques[j]) <= n)) j++;
  return [i, j];
}

function hashDeRango(bloques: JSONContent[], objetos: Objetos): string {
  const h = createHash("sha1");
  for (const b of bloques) h.update(hashDeBloque(b, objetos));
  return h.digest("hex").slice(0, 8);
}

/** Las secciones del documento, para que el agente sepa qué ids y huellas usar. */
function indice(bloques: JSONContent[], objetos: Objetos): string {
  const lineas: string[] = [];
  bloques.forEach((b) => {
    if (!esTitulo(b) || nivel(b) > 2) return;
    const r = rangoDeSeccion(bloques, String(b.attrs?.id))!;
    const cuerpo = bloques.slice(r[0], r[1]);
    // Pendiente es lo que falta en SU texto, hasta el siguiente título de
    // cualquier nivel: el título del documento no está pendiente porque una de
    // sus secciones lo esté.
    let fin = r[0] + 1;
    while (fin < r[1] && !esTitulo(bloques[fin])) fin++;
    const pendiente = bloques.slice(r[0], fin).some((x) => x.type === "pendiente") ? " (PENDIENTE)" : "";
    lineas.push(
      `- ${"#".repeat(nivel(b))} «${textoDe(b)}» seccion=${b.attrs?.id} huella_seccion=${hashDeRango(cuerpo, objetos)}${pendiente}`,
    );
  });
  return lineas.join("\n");
}

export function operacionesDeDocumento(
  roomId: string,
  dir: string,
  autor: string,
  avisar: () => void = () => {},
): OperacionesDeDocumento {
  const origen: Origen = { autor };

  const abierto = async (): Promise<DocVivo> => {
    const doc = await documentosVivos.abrir(roomId, dir);
    if (!doc) throw new ToolError("esta sala todavía no es un documento: empieza con iniciar_documento");
    return doc;
  };

  /** Quién tocó por última vez alguno de estos bloques, si no fui yo. */
  const quienCambio = (doc: DocVivo, bloques: JSONContent[]): string | null => {
    let ultimo: { autor: string; en: number } | null = null;
    for (const b of bloques) {
      const a = doc.autorPorBloque.get(String(b.attrs?.id));
      if (a && a.autor !== autor && (!ultimo || a.en > ultimo.en)) ultimo = a;
    }
    return ultimo?.autor ?? null;
  };

  const rechazo = (doc: DocVivo, que: string, bloques: JSONContent[]): ToolError => {
    const quien = quienCambio(doc, bloques);
    return new ToolError(
      `${que} cambió desde que lo leíste${quien ? ` (lo tocó ${quien})` : ""}. ` +
        `Vuelve a leerlo con leer_documento y haz tu cambio sobre lo nuevo; no repitas lo que ya está.`,
    );
  };

  const nuevosBloques = (markdown: string) => {
    if (!markdown.trim()) throw new ToolError("el markdown llegó vacío; para quitar un bloque usa borrar_bloque");
    const r = markdownABloques(markdown);
    if (r.bloques.length === 0) throw new ToolError("el markdown llegó vacío");
    return r;
  };

  const hecho = (texto: string) => {
    avisar();
    return texto;
  };

  return {
    existe: () => esDocumento(dir),

    async iniciar(titulo, secciones) {
      const md = [`# ${titulo}`, ...secciones.map((s) => `## ${s.titulo}\n\n<!-- pendiente: ${s.intencion.replace(/-->/g, "—")} -->`)].join("\n\n");
      try {
        await documentosVivos.crear(roomId, dir, md, origen);
      } catch (err) {
        throw new ToolError(String((err as Error).message ?? err));
      }
      avisar();
      return this.leer();
    },

    async leer(seccion) {
      const doc = await abierto();
      const { bloques, objetos } = estado(doc);
      let parte = bloques;
      if (seccion) {
        const r = rangoDeSeccion(bloques, seccion);
        if (!r) throw new ToolError(`no hay una sección con id ${seccion}; lee el documento completo para ver los ids`);
        parte = bloques.slice(r[0], r[1]);
      }
      return [
        `revisión ${doc.revision}`,
        "Secciones:",
        indice(bloques, objetos) || "(ninguna)",
        "",
        "Contenido (cada bloque va precedido de ⟦id·huella⟧):",
        bloquesAMarkdown(parte, objetos, { conIds: true }) || "(vacío)",
      ].join("\n");
    },

    async escribirSeccion(seccion, hash, markdown) {
      const doc = await abierto();
      const { bloques, objetos } = estado(doc);
      const r = rangoDeSeccion(bloques, seccion);
      if (!r) throw new ToolError(`no hay una sección con id ${seccion}`);
      const actual = bloques.slice(r[0], r[1]);
      if (hashDeRango(actual, objetos) !== hash) throw rechazo(doc, `La sección «${textoDe(bloques[r[0]])}»`, actual);
      const nuevo = nuevosBloques(markdown);
      let cuerpo = nuevo.bloques;
      const titulo = { ...bloques[r[0]] };
      // Si el markdown trae su propio título, reemplaza al de la sección pero
      // conserva el id: los comentarios y los demás agentes la siguen encontrando.
      if (esTitulo(cuerpo[0])) {
        Object.assign(titulo, cuerpo[0], { attrs: { ...cuerpo[0].attrs, id: titulo.attrs?.id } });
        cuerpo = cuerpo.slice(1);
      }
      aplicar(doc, origen, (a) => ({
        bloques: [...a.bloques.slice(0, r[0]), titulo, ...cuerpo, ...a.bloques.slice(r[1])],
        objetos: nuevo.objetos,
      }));
      return hecho(`sección «${textoDe(titulo)}» escrita (${cuerpo.length} bloques)`);
    },

    async reemplazarBloque(id, hash, markdown) {
      const doc = await abierto();
      const { bloques, objetos } = estado(doc);
      const i = bloques.findIndex((b) => b.attrs?.id === id);
      if (i < 0) throw new ToolError(`no hay un bloque con id ${id}`);
      if (hashDeBloque(bloques[i], objetos) !== hash) throw rechazo(doc, "Ese bloque", [bloques[i]]);
      const nuevo = nuevosBloques(markdown);
      // Un bloque que se reemplaza por uno del mismo tipo conserva su id.
      if (nuevo.bloques.length === 1 && nuevo.bloques[0].type === bloques[i].type) {
        nuevo.bloques[0] = { ...nuevo.bloques[0], attrs: { ...nuevo.bloques[0].attrs, id } };
      }
      aplicar(doc, origen, (a) => ({
        bloques: [...a.bloques.slice(0, i), ...nuevo.bloques, ...a.bloques.slice(i + 1)],
        objetos: nuevo.objetos,
      }));
      return hecho(`bloque reemplazado (${nuevo.bloques.length} nuevo${nuevo.bloques.length > 1 ? "s" : ""})`);
    },

    async insertarBloques(despuesDe, markdown) {
      const doc = await abierto();
      const { bloques } = estado(doc);
      const i = despuesDe === "inicio" ? -1 : bloques.findIndex((b) => b.attrs?.id === despuesDe);
      if (i < 0 && despuesDe !== "inicio") throw new ToolError(`no hay un bloque con id ${despuesDe}`);
      const nuevo = nuevosBloques(markdown);
      aplicar(doc, origen, (a) => ({
        bloques: [...a.bloques.slice(0, i + 1), ...nuevo.bloques, ...a.bloques.slice(i + 1)],
        objetos: nuevo.objetos,
      }));
      return hecho(`${nuevo.bloques.length} bloque${nuevo.bloques.length > 1 ? "s" : ""} insertado${nuevo.bloques.length > 1 ? "s" : ""}`);
    },

    async borrarBloque(id, hash) {
      const doc = await abierto();
      const { bloques, objetos } = estado(doc);
      const i = bloques.findIndex((b) => b.attrs?.id === id);
      if (i < 0) throw new ToolError(`no hay un bloque con id ${id}`);
      if (hashDeBloque(bloques[i], objetos) !== hash) throw rechazo(doc, "Ese bloque", [bloques[i]]);
      aplicar(doc, origen, (a) => ({ bloques: [...a.bloques.slice(0, i), ...a.bloques.slice(i + 1)] }));
      return hecho("bloque borrado");
    },

    async moverSeccion(seccion, antesDe) {
      const doc = await abierto();
      const { bloques } = estado(doc);
      const r = rangoDeSeccion(bloques, seccion);
      if (!r) throw new ToolError(`no hay una sección con id ${seccion}`);
      const parte = bloques.slice(r[0], r[1]);
      const resto = [...bloques.slice(0, r[0]), ...bloques.slice(r[1])];
      let k = resto.length;
      if (antesDe) {
        k = resto.findIndex((b) => b.attrs?.id === antesDe);
        if (k < 0) throw new ToolError(`no hay un bloque con id ${antesDe} fuera de la sección que mueves`);
      }
      aplicar(doc, origen, () => ({ bloques: [...resto.slice(0, k), ...parte, ...resto.slice(k)] }));
      return hecho(`sección «${textoDe(parte[0])}» movida`);
    },

    async cambiarObjeto(id, hash, fuente) {
      const doc = await abierto();
      const { bloques, objetos } = estado(doc);
      const b = bloques.find((x) => x.attrs?.id === id);
      if (!b || (b.type !== "grafica" && b.type !== "diagrama")) {
        throw new ToolError(`no hay una gráfica ni un diagrama con id ${id}`);
      }
      if (hashDeBloque(b, objetos) !== hash) throw rechazo(doc, b.type === "grafica" ? "Esa gráfica" : "Ese diagrama", [b]);
      if (b.type === "grafica") {
        try {
          JSON.parse(fuente);
        } catch {
          throw new ToolError("los datos de la gráfica no son JSON válido");
        }
      }
      cambiarObjeto(doc, origen, String(b.attrs?.ref), fuente);
      return hecho(b.type === "grafica" ? "gráfica actualizada" : "diagrama actualizado");
    },
  };
}

// ── Las tools ────────────────────────────────────────────────────────────────

function ops(ctx: Parameters<Tool["run"]>[1]): OperacionesDeDocumento {
  if (!ctx.documento) throw new ToolError("aquí no hay documento disponible");
  return ctx.documento;
}

const RUTA = `${CARPETA_DOCUMENTO}/${ARCHIVO_MD}`;

/**
 * Convierte la sala en un documento y deja el esqueleto listo para llenarse.
 *
 * La sala nace sin tipo; quien decide si es software o documento es el agente
 * con el primer pedido. Que sea una tool deja la decisión registrada: Multi sabe
 * cuándo cambió y lo avisa a la sala.
 */
export const iniciarDocumentoTool: Tool = {
  spec: {
    name: "iniciar_documento",
    description:
      "Convierte la sala en un DOCUMENTO (ensayo, reporte, propuesta, manual, plan, investigación…) y crea su esqueleto: " +
      "el título y una sección pendiente por cada parte, con lo que va a llevar. Multi pinta el documento en el panel de " +
      "la sala, las personas lo editan ahí mismo, y se exporta. Úsala UNA vez, al empezar, y solo si la sala no tiene " +
      "proyecto. Devuelve el documento con los ids y huellas de cada sección para llenarlas con escribir_seccion.",
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
    const secciones = (Array.isArray(input.secciones) ? input.secciones : [])
      .map((s) => s as { titulo?: unknown; intencion?: unknown })
      .filter((s) => typeof s.titulo === "string" && s.titulo.trim())
      .map((s) => ({ titulo: String(s.titulo), intencion: typeof s.intencion === "string" ? s.intencion : "" }));
    if (secciones.length === 0) throw new ToolError("hace falta al menos una sección con título");
    if (secciones.length > 40) throw new ToolError("son demasiadas secciones; agrupa en 40 o menos");

    const documento = ops(ctx);
    if (documento.existe()) {
      throw new ToolError("esta sala ya es un documento: léelo con leer_documento y trabaja sobre él en vez de empezar otro");
    }
    if ((await detectLaunch(ctx.workspaceDir)) !== null) {
      throw new ToolError(
        "esta sala ya tiene un proyecto de software; un documento no cabe aquí. Si lo que piden es un documento, sugiere abrir una sala nueva",
      );
    }
    const leido = await documento.iniciar(titulo, secciones);
    ctx.emit?.({ type: "file:changed", path: RUTA, action: "write" });
    return `documento iniciado: "${titulo}" con ${secciones.length} secciones pendientes. Llénalas con escribir_seccion.\n\n${leido}`;
  },
};

export const leerDocumentoTool: Tool = {
  spec: {
    name: "leer_documento",
    description:
      "Lee el documento de la sala en markdown. Cada bloque viene precedido de ⟦id·huella⟧ y hay un índice de secciones " +
      "con su id y su huella_seccion. Esos ids y huellas son los que piden las demás tools del documento. Léelo antes de " +
      "cambiar algo: las personas lo editan en vivo y lo que leíste hace rato puede haber cambiado.",
    input_schema: {
      type: "object",
      properties: {
        seccion: { type: "string", description: "Opcional: id de una sección para leer solo esa" },
      },
    },
  },
  async run(input, ctx) {
    return ops(ctx).leer(optString(input, "seccion"));
  },
};

/** Para las tools que cambian: avisan a la sala como cualquier escritura. */
function cambio(ctx: Parameters<Tool["run"]>[1], texto: string): string {
  ctx.emit?.({ type: "file:changed", path: RUTA, action: "edit" });
  return texto;
}

export const escribirSeccionTool: Tool = {
  spec: {
    name: "escribir_seccion",
    description:
      "Escribe (o reescribe) una sección completa en markdown: así se llena una sección PENDIENTE. Empieza con su título " +
      "(## Título). Pide el id de la sección y su huella_seccion de leer_documento: si alguien la cambió mientras tanto, " +
      "se rechaza y hay que releerla. Para cambiar solo una parte de una sección escrita, usa reemplazar_bloque.",
    input_schema: {
      type: "object",
      properties: {
        seccion: { type: "string", description: "id del título de la sección" },
        huella: { type: "string", description: "huella_seccion que te dio leer_documento" },
        markdown: { type: "string", description: "La sección completa, empezando por ## Título" },
      },
      required: ["seccion", "huella", "markdown"],
    },
  },
  async run(input, ctx) {
    return cambio(
      ctx,
      await ops(ctx).escribirSeccion(reqString(input, "seccion"), reqString(input, "huella"), reqString(input, "markdown")),
    );
  },
};

export const reemplazarBloqueTool: Tool = {
  spec: {
    name: "reemplazar_bloque",
    description:
      "Reemplaza UN bloque (párrafo, lista, tabla, título…) por el markdown que mandes (puede ser más de un bloque). " +
      "Pide su id y su huella de leer_documento. Es la forma de cambiar algo sin tocar el resto de la sección.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        huella: { type: "string" },
        markdown: { type: "string" },
      },
      required: ["id", "huella", "markdown"],
    },
  },
  async run(input, ctx) {
    return cambio(
      ctx,
      await ops(ctx).reemplazarBloque(reqString(input, "id"), reqString(input, "huella"), reqString(input, "markdown")),
    );
  },
};

export const insertarBloquesTool: Tool = {
  spec: {
    name: "insertar_bloques",
    description:
      "Inserta bloques nuevos (markdown) después del bloque con ese id, o al principio con despues_de=\"inicio\". " +
      "Para agregar una sección nueva, inserta su ## Título y su contenido después del último bloque de la anterior.",
    input_schema: {
      type: "object",
      properties: {
        despues_de: { type: "string", description: "id del bloque, o \"inicio\"" },
        markdown: { type: "string" },
      },
      required: ["despues_de", "markdown"],
    },
  },
  async run(input, ctx) {
    return cambio(ctx, await ops(ctx).insertarBloques(reqString(input, "despues_de"), reqString(input, "markdown")));
  },
};

export const borrarBloqueTool: Tool = {
  spec: {
    name: "borrar_bloque",
    description: "Borra UN bloque. Pide su id y su huella de leer_documento.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" }, huella: { type: "string" } },
      required: ["id", "huella"],
    },
  },
  async run(input, ctx) {
    return cambio(ctx, await ops(ctx).borrarBloque(reqString(input, "id"), reqString(input, "huella")));
  },
};

export const moverSeccionTool: Tool = {
  spec: {
    name: "mover_seccion",
    description:
      "Mueve una sección completa (su título y lo que tiene) antes del bloque con id antes_de, o al final si no lo mandas.",
    input_schema: {
      type: "object",
      properties: { seccion: { type: "string" }, antes_de: { type: "string" } },
      required: ["seccion"],
    },
  },
  async run(input, ctx) {
    return cambio(ctx, await ops(ctx).moverSeccion(reqString(input, "seccion"), optString(input, "antes_de") ?? null));
  },
};

export const cambiarGraficaTool: Tool = {
  spec: {
    name: "cambiar_grafica",
    description:
      "Cambia los datos de una gráfica ya existente, sin tocar el texto alrededor. `datos` es el mismo JSON del bloque " +
      "grafica: {tipo, titulo, etiquetas, series:[{nombre, datos}]}. Pide el id del bloque y su huella.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" }, huella: { type: "string" }, datos: { type: "object" } },
      required: ["id", "huella", "datos"],
    },
  },
  async run(input, ctx) {
    const datos = input.datos;
    if (!datos || typeof datos !== "object") throw new ToolError("faltan los datos de la gráfica");
    return cambio(
      ctx,
      await ops(ctx).cambiarObjeto(reqString(input, "id"), reqString(input, "huella"), JSON.stringify(datos)),
    );
  },
};

export const cambiarDiagramaTool: Tool = {
  spec: {
    name: "cambiar_diagrama",
    description: "Reemplaza el SVG de un diagrama ya existente. Pide el id del bloque y su huella.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" }, huella: { type: "string" }, svg: { type: "string" } },
      required: ["id", "huella", "svg"],
    },
  },
  async run(input, ctx) {
    return cambio(ctx, await ops(ctx).cambiarObjeto(reqString(input, "id"), reqString(input, "huella"), reqString(input, "svg")));
  },
};

export const documentoTools: Tool[] = [
  iniciarDocumentoTool,
  leerDocumentoTool,
  escribirSeccionTool,
  reemplazarBloqueTool,
  insertarBloquesTool,
  borrarBloqueTool,
  moverSeccionTool,
  cambiarGraficaTool,
  cambiarDiagramaTool,
];
