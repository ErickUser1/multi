import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createWorkspace } from "../engine/workspace.js";
import { guardarVariables, leerVariables } from "../engine/env.js";

/**
 * Demo: las variables del proyecto de una sala (su `.env`).
 * Uso: npm run demo:variables
 *
 * Lo que importa comprobar aquí es que el archivo quede LEGIBLE: lo van a leer
 * el proyecto (con el cargador de su stack) y el agente (con read_file). Un
 * nombre con espacios o un valor con salto de línea rompen el formato, y la app
 * dejaría de arrancar por una variable que alguien tecleó mal en el panel.
 *
 * No necesita red ni servidor: prueba el módulo que escribe el archivo.
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

async function main() {
  console.log("\n=== variables del proyecto ===\n");

  const ws = await createWorkspace("demo-variables", { clean: true });

  console.log("1. Una sala nueva no tiene ninguna");
  check("empieza vacía", (await leerVariables(ws.dir)).length === 0);

  console.log("\n2. Se guardan y se vuelven a leer");
  await guardarVariables(ws.dir, [
    { nombre: "SUPABASE_URL", valor: "https://abc.supabase.co" },
    { nombre: "SUPABASE_ANON_KEY", valor: "ey.Jhb-Gci_OiJ" },
  ]);
  const leidas = await leerVariables(ws.dir);
  check("son dos", leidas.length === 2, String(leidas.length));
  check("el valor sobrevive entero", leidas[0].valor === "https://abc.supabase.co", leidas[0].valor);

  console.log("\n3. El archivo se ve como un .env de verdad");
  const texto = await readFile(join(ws.dir, ".env"), "utf8");
  check("formato NOMBRE=valor", texto.includes('SUPABASE_URL="https://abc.supabase.co"'));
  check("lleva una explicación arriba", texto.startsWith("#"));

  console.log("\n4. Lo que rompería el archivo se descarta");
  await guardarVariables(ws.dir, [
    { nombre: "BUENA", valor: "si" },
    { nombre: "con espacios", valor: "no" },
    { nombre: "2EMPIEZA_CON_NUMERO", valor: "no" },
    { nombre: "SALTO", valor: "linea1\nlinea2" },
  ]);
  const v2 = await leerVariables(ws.dir);
  check("solo quedan las que un shell acepta", v2.length === 2, v2.map((v) => v.nombre).join(","));
  check(
    "el salto de línea se aplana en vez de partir la asignación",
    v2.find((v) => v.nombre === "SALTO")?.valor === "linea1 linea2",
  );

  console.log("\n5. La lista que manda el panel es la que queda");
  // Borrar es no mandarla: así el panel no necesita una operación aparte para
  // quitar una variable.
  await guardarVariables(ws.dir, [{ nombre: "UNICA", valor: "1" }]);
  const v3 = await leerVariables(ws.dir);
  check("las anteriores se fueron", v3.length === 1, v3.map((v) => v.nombre).join(","));

  console.log("\n6. Y no entra al historial de la sala");
  const gitignore = await readFile(join(ws.dir, ".gitignore"), "utf8");
  check("el .env está ignorado", gitignore.includes(".env"));

  console.log(`\n${pass} pasaron, ${fail} fallaron\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\ndemo falló:", err);
  process.exit(1);
});
