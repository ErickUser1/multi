import { type Tool, ToolError } from "./base.js";
import { CONSULTA_ESQUEMA } from "../../supabase.js";

/**
 * Ver la base que la sala conectó: su estructura, o las filas de una consulta.
 *
 * Por qué existe: la tool `sql` solo cambia la estructura y contesta "listo".
 * Sin ver qué tablas y columnas hay, el agente las adivinaba y escribía código
 * contra columnas que no existían, sobre todo en un proyecto adoptado, donde
 * `migraciones/` está vacía aunque la base no. Tampoco podía comprobar si algo
 * se guardó.
 *
 * Nunca escribe. Quien lo garantiza es Supabase, que corre todo en una
 * transacción de solo lectura; lo que se revisa aquí es solo para contestar
 * claro antes de gastar una llamada. Por eso tampoco deja migración.
 */

/** Cuántas filas llegan al agente, como mucho. */
export const MAX_FILAS = 50;
/** Y cuánto texto: una fila puede traer un JSON enorme. */
const MAX_CARACTERES = 8000;

export const verBaseTool: Tool = {
  spec: {
    name: "ver_base",
    description:
      "Mira la base de datos de la sala, sin cambiar nada. Sin `consulta`, devuelve la " +
      "estructura: tablas, columnas, llaves, si tienen RLS y sus políticas. Úsalo ANTES de " +
      "crear o cambiar tablas y antes de escribir código que las use, en vez de adivinar " +
      `columnas. Con \`consulta\` (un SELECT), devuelve hasta ${MAX_FILAS} filas: sirve para ` +
      "comprobar que algo se guardó o contar registros. No pasa por la app: lo que ves aquí " +
      "puede no ser lo que la app ve, porque la app pasa por las políticas de RLS.",
    input_schema: {
      type: "object",
      properties: {
        consulta: {
          type: "string",
          description: "Opcional. Un SELECT (o WITH … SELECT) para ver filas. Sin esto, la estructura.",
        },
      },
    },
  },
  async run(input, ctx) {
    if (!ctx.leerBase) {
      throw new ToolError(
        "esta sala no tiene base de datos conectada. Se conecta desde el panel de Variables, " +
          "con el botón de Supabase. Dilo en el chat y sigue con lo que sí puedas hacer.",
      );
    }
    const consulta = typeof input.consulta === "string" ? input.consulta.trim() : "";

    if (!consulta) {
      return describirEsquema(await leer(ctx.leerBase, CONSULTA_ESQUEMA));
    }

    if (!esDeLectura(consulta)) {
      throw new ToolError(
        "ver_base solo lee: la consulta tiene que empezar con SELECT, WITH, EXPLAIN, SHOW, " +
          "TABLE o VALUES. Para cambiar la estructura usa la tool sql; las filas de la app " +
          "las escribe el código de la app.",
      );
    }
    return describirFilas(await leer(ctx.leerBase, conTope(consulta)));
  },
};

async function leer(leerBase: (sql: string) => Promise<unknown>, sql: string): Promise<unknown> {
  try {
    return await leerBase(sql);
  } catch (err) {
    // Lo que diga Postgres le sirve al agente para corregir la consulta. Como
    // `error inesperado` parecía una falla de Multi, no de su SQL.
    const msg = err instanceof Error ? err.message : String(err);
    throw new ToolError(`la base respondió con error, no se leyó nada: ${msg}`);
  }
}

/** Quita comentarios y espacios del principio, que no cambian qué es la consulta. */
function sinComentariosAlInicio(sql: string): string {
  let s = sql.trimStart();
  for (;;) {
    if (s.startsWith("--")) s = s.slice(s.indexOf("\n") + 1 || s.length).trimStart();
    else if (s.startsWith("/*")) s = s.slice((s.indexOf("*/") + 2) || s.length).trimStart();
    else return s;
  }
}

export function esDeLectura(sql: string): boolean {
  return /^(select|with|explain|show|table|values)\b/i.test(sinComentariosAlInicio(sql));
}

/**
 * Le pone tope a una consulta de un solo SELECT, para que una tabla grande no
 * viaje entera solo para recortarla aquí. Se pide una fila de más para saber si
 * había más. Lo que no se puede envolver (un EXPLAIN, varias sentencias) va tal
 * cual y se recorta al llegar.
 */
export function conTope(sql: string): string {
  const limpia = sinComentariosAlInicio(sql).replace(/;\s*$/, "");
  if (limpia.includes(";") || !/^(select|with)\b/i.test(limpia)) return sql;
  return `select * from (\n${limpia}\n) as consulta limit ${MAX_FILAS + 1}`;
}

export function describirFilas(respuesta: unknown): string {
  const filas = Array.isArray(respuesta) ? respuesta : [];
  if (filas.length === 0) return "0 filas.";
  const vistas = filas.slice(0, MAX_FILAS);
  let texto = vistas.map((f) => JSON.stringify(f)).join("\n");
  if (texto.length > MAX_CARACTERES) texto = texto.slice(0, MAX_CARACTERES) + "\n… (recortado)";
  const cuantas =
    filas.length > MAX_FILAS
      ? `más de ${MAX_FILAS} filas; aquí van las primeras ${MAX_FILAS}. Filtra o agrega para ver el resto.`
      : `${filas.length} ${filas.length === 1 ? "fila" : "filas"}.`;
  return `${cuantas}\n${texto}`;
}

interface Columna {
  nombre: string;
  tipo: string;
  nulo: boolean;
  default: string | null;
}
interface Politica {
  nombre: string;
  para: string;
  roles: string[] | string | null;
  using: string | null;
  check: string | null;
}
interface TablaDeEsquema {
  tabla: string;
  rls: boolean;
  rls_forzado: boolean;
  columnas: Columna[];
  llaves: string[];
  politicas: Politica[];
}

/** La estructura, en el texto más corto que el agente pueda usar sin adivinar. */
export function describirEsquema(respuesta: unknown): string {
  const tablas = (Array.isArray(respuesta) ? respuesta : []) as TablaDeEsquema[];
  if (tablas.length === 0) return "La base no tiene tablas todavía (esquema public vacío).";

  const bloques = tablas.map((t) => {
    const rls = t.rls_forzado ? "RLS forzado" : t.rls ? "RLS activo" : "SIN RLS";
    const lineas = [`${t.tabla} (${rls})`];
    for (const c of t.columnas ?? []) {
      const partes = [`  ${c.nombre} ${c.tipo}`];
      if (!c.nulo) partes.push("not null");
      if (c.default) partes.push(`default ${c.default}`);
      lineas.push(partes.join(" "));
    }
    for (const k of t.llaves ?? []) lineas.push(`  ${k}`);
    const politicas = t.politicas ?? [];
    if (politicas.length === 0 && t.rls) {
      lineas.push("  sin políticas: con RLS así, la app no puede leer ni escribir nada");
    }
    for (const p of politicas) {
      const roles = Array.isArray(p.roles) ? p.roles.join(",") : (p.roles ?? "").replace(/[{}]/g, "");
      let linea = `  política "${p.nombre}" ${p.para} to ${roles || "public"}`;
      if (p.using) linea += ` using (${p.using})`;
      if (p.check) linea += ` with check (${p.check})`;
      lineas.push(linea);
    }
    return lineas.join("\n");
  });

  let texto = `${tablas.length} ${tablas.length === 1 ? "tabla" : "tablas"} en public:\n\n${bloques.join("\n\n")}`;
  if (texto.length > MAX_CARACTERES * 2) texto = texto.slice(0, MAX_CARACTERES * 2) + "\n… (recortado)";
  return texto;
}
