import { mkdtemp, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { politicasAbiertas } from "../agent/tools/politicas.js";
import { sqlTool } from "../agent/tools/sql.js";
import { ToolError, type ToolContext } from "../agent/tools/base.js";

/**
 * Demo: la tool sql no deja pasar políticas de RLS abiertas.
 * Uso: npm run demo:politicas
 *
 * El caso que la motivó es real: el agente activó RLS en todas las tablas de
 * una app de ubicación de menores y les puso `using (true)` a todas. RLS
 * prendido, base abierta igual. El primer bloque de abajo es ese SQL tal cual.
 *
 * No necesita red ni base: el SQL se "corre" contra una función que solo anota
 * lo que recibió.
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

const DE_LA_SALA = `
-- Este módulo no usa Supabase Auth, así que las políticas son permisivas.
drop policy if exists "profiles_select_all" on qroapp_profiles;
create policy "profiles_select_all" on qroapp_profiles
  for select using (true);
create policy "profiles_insert_all" on qroapp_profiles
  for insert with check (true);
create policy "profiles_update_all" on qroapp_profiles
  for update using (true) with check (true);
create policy "locations_select_all" on qroapp_locations
  for select using (true);
`;

async function main() {
  console.log("\n=== políticas abiertas ===\n");

  console.log("1. El SQL de la sala real");
  const real = politicasAbiertas(DE_LA_SALA);
  check(
    "encuentra las dos de escritura",
    real.escritura.map((p) => p.nombre).join(",") === "profiles_insert_all,profiles_update_all",
    JSON.stringify(real.escritura),
  );
  check(
    "y las dos de lectura",
    real.lectura.map((p) => p.nombre).join(",") === "profiles_select_all,locations_select_all",
    JSON.stringify(real.lectura),
  );

  console.log("\n2. Las variantes");
  check(
    "sin FOR cubre todo, así que es de escritura",
    politicasAbiertas(`create policy todo on t using (true);`).escritura.length === 1,
  );
  check(
    "paréntesis de más no la esconden",
    politicasAbiertas(`create policy p on t for insert with check ((true));`).escritura.length === 1,
  );
  check(
    "ALTER POLICY también cuenta",
    politicasAbiertas(`alter policy p on t using (true);`).escritura.length === 1,
  );
  check(
    "mayúsculas y saltos de línea",
    politicasAbiertas(`CREATE POLICY "P"\n  ON t\n  FOR DELETE\n  USING (TRUE);`).escritura.length === 1,
  );

  console.log("\n3. Lo que NO es una política abierta");
  const buenas = politicasAbiertas(`
    create policy "lo_mio" on perfiles for select to authenticated
      using (auth.uid() = user_id);
    create policy "mis_filas" on ubicaciones for insert
      with check (auth.uid() = user_id);
    create policy "vinculados" on ubicaciones for select using (
      exists (select 1 from vinculos v where v.familiar = auth.uid() and v.persona = user_id and true)
    );
  `);
  check("auth.uid() y exists pasan", buenas.escritura.length + buenas.lectura.length === 0);
  check(
    "un comentario con una política no cuenta",
    politicasAbiertas(`-- create policy x on t using (true);\nselect 1;`).escritura.length === 0,
  );
  check(
    "un ; dentro de una función no parte la sentencia",
    politicasAbiertas(`
      create or replace function f() returns void language plpgsql as $$
      begin
        perform 1; -- create policy x on t using (true);
      end;
      $$;
    `).escritura.length === 0,
  );

  console.log("\n4. La tool sql");
  const dir = await mkdtemp(join(tmpdir(), "multi-politicas-"));
  const corridas: string[] = [];
  const ctx = {
    workspaceDir: dir,
    ejecutarSql: async (sql: string) => {
      corridas.push(sql);
    },
  } as unknown as ToolContext;

  let error = "";
  try {
    await sqlTool.run({ sql: DE_LA_SALA, descripcion: "politicas-abiertas" }, ctx);
  } catch (err) {
    error = err instanceof ToolError ? err.message : `otro error: ${err}`;
  }
  check("rechaza el SQL con políticas de escritura abiertas", error.includes("no se corrió nada"), error);
  check("el mensaje le dice qué usar", error.includes("auth.uid()") && error.includes("signInAnonymously"));
  check("y no corrió nada contra la base", corridas.length === 0, String(corridas.length));
  check("ni dejó migración", !existsSync(join(dir, "migraciones")));

  const lectura = await sqlTool.run(
    { sql: `create policy "menu_publico" on menu for select using (true);`, descripcion: "menu-publico" },
    ctx,
  );
  check("una de lectura sí corre", corridas.length === 1);
  check("pero avisa", String(lectura).includes("Ojo") && String(lectura).includes("menu_publico"));

  const buena = await sqlTool.run(
    {
      sql: `create policy "lo_mio" on notas for all using (auth.uid() = user_id) with check (auth.uid() = user_id);`,
      descripcion: "notas-propias",
    },
    ctx,
  );
  check("una bien hecha corre sin aviso", corridas.length === 2 && !String(buena).includes("Ojo"));
  check("y deja sus migraciones", (await readdir(join(dir, "migraciones"))).length === 2);

  await rm(dir, { recursive: true, force: true });

  console.log(`\n${pass} pasaron, ${fail} fallaron\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\ndemo falló:", err);
  process.exit(1);
});
