import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verBaseTool, conTope, esDeLectura, MAX_FILAS } from "../agent/tools/ver-base.js";
import { sqlTool } from "../agent/tools/sql.js";
import { ToolError, type ToolContext } from "../agent/tools/base.js";
import { CONSULTA_ESQUEMA } from "../supabase.js";

/**
 * Demo: el agente puede ver la base de la sala, sin cambiarla.
 * Uso: npm run demo:ver-base
 *
 * Antes la única tool de la base era `sql`, que contesta "listo" y nada más: el
 * agente adivinaba tablas y columnas. Esto revisa que `ver_base` describa la
 * estructura, traiga filas con tope, y no deje pasar nada que escriba.
 *
 * No necesita red ni base: la consulta se "corre" contra una función que anota
 * lo que recibió y devuelve lo que devolvería Supabase.
 */

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  [ok] ${name}`);
  } else {
    fail++;
    console.log(`  [X]  ${name} ${detail}`);
  }
}

/** Lo que devuelve CONSULTA_ESQUEMA en una base como la de una sala real. */
const ESQUEMA = [
  {
    tabla: "tareas",
    rls: true,
    rls_forzado: true,
    columnas: [
      { nombre: "id", tipo: "uuid", nulo: false, default: "gen_random_uuid()" },
      { nombre: "user_id", tipo: "uuid", nulo: false, default: "auth.uid()" },
      { nombre: "titulo", tipo: "text", nulo: false, default: null },
      { nombre: "hecha", tipo: "boolean", nulo: true, default: "false" },
    ],
    llaves: ["PRIMARY KEY (id)", "FOREIGN KEY (user_id) REFERENCES auth.users(id)"],
    politicas: [
      { nombre: "mis_tareas", para: "ALL", roles: "{authenticated}", using: "(auth.uid() = user_id)", check: "(auth.uid() = user_id)" },
    ],
  },
  {
    tabla: "notas",
    rls: true,
    rls_forzado: false,
    columnas: [{ nombre: "id", tipo: "bigint", nulo: false, default: null }],
    llaves: [],
    politicas: [],
  },
];

async function main() {
  console.log("\n=== ver la base ===\n");

  const dir = await mkdtemp(join(tmpdir(), "multi-ver-base-"));
  const pedidas: string[] = [];
  let respuesta: unknown = [];
  const ctx = {
    workspaceDir: dir,
    leerBase: async (sql: string) => {
      pedidas.push(sql);
      return respuesta;
    },
  } as unknown as ToolContext;
  const correr = async (input: Record<string, unknown>, c: ToolContext = ctx): Promise<string> => {
    try {
      return String(await verBaseTool.run(input, c));
    } catch (err) {
      return err instanceof ToolError ? `ERROR: ${err.message}` : `OTRO ERROR: ${err}`;
    }
  };

  console.log("1. Sin consulta, la estructura");
  respuesta = ESQUEMA;
  const esquema = await correr({});
  check("pide la consulta del catálogo", pedidas.at(-1) === CONSULTA_ESQUEMA);
  check("cuenta las tablas", esquema.startsWith("2 tablas en public"), esquema.split("\n")[0]);
  check("dice si el RLS está forzado", esquema.includes("tareas (RLS forzado)"));
  check("columnas con tipo, not null y default", esquema.includes("user_id uuid not null default auth.uid()"));
  check("las llaves", esquema.includes("FOREIGN KEY (user_id) REFERENCES auth.users(id)"));
  check(
    "las políticas, con sus roles",
    esquema.includes('política "mis_tareas" ALL to authenticated using ((auth.uid() = user_id))'),
    esquema,
  );
  check("avisa de una tabla con RLS y sin políticas", esquema.includes("sin políticas"));
  respuesta = [];
  check("una base vacía lo dice", (await correr({})).includes("no tiene tablas"));

  console.log("\n2. Con consulta, las filas, con tope");
  respuesta = Array.from({ length: MAX_FILAS + 1 }, (_, i) => ({ id: i, titulo: `tarea ${i}` }));
  const filas = await correr({ consulta: "select * from tareas;" });
  check(
    "la consulta viaja envuelta con limit",
    pedidas.at(-1) === `select * from (\nselect * from tareas\n) as consulta limit ${MAX_FILAS + 1}`,
    pedidas.at(-1),
  );
  check("avisa que hay más", filas.startsWith(`más de ${MAX_FILAS} filas`), filas.split("\n")[0]);
  check(`y trae solo ${MAX_FILAS}`, filas.split("\n").length === MAX_FILAS + 1);
  respuesta = [{ total: 3 }];
  check("una sola fila", (await correr({ consulta: "select count(*) as total from tareas" })) === '1 fila.\n{"total":3}');
  respuesta = [];
  check("cero filas", (await correr({ consulta: "select * from tareas where false" })) === "0 filas.");
  check(
    "un WITH también se envuelve",
    conTope("with x as (select 1) select * from x").endsWith(`limit ${MAX_FILAS + 1}`),
  );
  check("un EXPLAIN va tal cual", conTope("explain select 1") === "explain select 1");
  check("varias sentencias van tal cual", conTope("select 1; select 2") === "select 1; select 2");
  check("los comentarios del principio no confunden", esDeLectura("-- cuántas\n/* hay */ select 1"));

  console.log("\n3. Lo que escribe no pasa");
  const antes = pedidas.length;
  for (const q of ["delete from tareas", "update tareas set hecha = true", "drop table notas", "insert into notas values (1)"]) {
    const r = await correr({ consulta: q });
    check(`rechaza: ${q}`, r.startsWith("ERROR: ver_base solo lee"), r);
  }
  check("sin llamar a la base", pedidas.length === antes);
  check("ni dejar migración", !existsSync(join(dir, "migraciones")));

  console.log("\n4. Errores y sala sin base");
  const sinBase = await correr({}, { workspaceDir: dir } as unknown as ToolContext);
  check("sin base, dice cómo conectarla", sinBase.includes("panel de Variables"), sinBase);
  const conFallo = {
    workspaceDir: dir,
    leerBase: async () => {
      throw new Error('respondió 400: {"message":"ERROR: 42703: column \\"nombre\\" does not exist"}');
    },
  } as unknown as ToolContext;
  const fallo = await correr({ consulta: "select nombre from tareas" }, conFallo);
  check("el error de Postgres llega limpio", fallo.startsWith("ERROR: la base respondió con error") && fallo.includes("42703"), fallo);

  console.log("\n5. Y sql ya no dice 'error inesperado'");
  const sqlConFallo = {
    workspaceDir: dir,
    ejecutarSql: async () => {
      throw new Error('respondió 400: {"message":"ERROR: 42P07: relation \\"tareas\\" already exists"}');
    },
  } as unknown as ToolContext;
  let errSql = "";
  try {
    await sqlTool.run({ sql: "create table tareas (id bigint)", descripcion: "crea-tareas" }, sqlConFallo);
  } catch (err) {
    errSql = err instanceof ToolError ? err.message : `OTRO ERROR: ${err}`;
  }
  check("el error es de la tool, con lo que dijo Postgres", errSql.includes("42P07"), errSql);
  check("y le dice que revise con ver_base", errSql.includes("ver_base"));
  check("sin migración de algo que falló", !existsSync(join(dir, "migraciones")));

  await rm(dir, { recursive: true, force: true });
  console.log(`\n${pass} pasaron, ${fail} fallaron\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\ndemo falló:", err);
  process.exit(1);
});
