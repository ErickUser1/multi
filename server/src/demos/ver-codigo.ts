import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createWorkspace } from "../engine/workspace.js";
import { archivosDelProyecto, leerArchivoDelProyecto, MAX_BYTES_ARCHIVO } from "../engine/codigo.js";

/**
 * Demo: el botón "Código" enseña el proyecto y nada más.
 * Uso: npm run demo:ver-codigo
 *
 * Lo que se protege es la frontera: que el `.env` (con las llaves de la sala),
 * `node_modules` y cualquier cosa fuera del workspace no salgan por aquí, ni
 * listados ni pidiéndolos por su ruta con trucos. Usa un workspace de verdad,
 * con las reglas de exclusión que pone Multi, para probar las mismas que corren
 * en el server.
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

async function main(): Promise<void> {
  console.log("=== Ver el código de la sala ===\n");
  const ws = await createWorkspace(`_ver-codigo-${Date.now()}`, { clean: true });
  const dir = ws.dir;

  try {
    await mkdir(join(dir, "src"), { recursive: true });
    await mkdir(join(dir, "node_modules", "react"), { recursive: true });
    await mkdir(join(dir, "dist"), { recursive: true });
    await writeFile(join(dir, "package.json"), '{"name":"demo"}');
    await writeFile(join(dir, "src", "App.tsx"), "export const App = () => <h1>Hola</h1>;\n");
    await writeFile(join(dir, ".env"), "VITE_SUPABASE_ANON_KEY=secreto\n");
    await writeFile(join(dir, "node_modules", "react", "index.js"), "module.exports = {};");
    await writeFile(join(dir, "dist", "index.html"), "<html></html>");
    await writeFile(join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
    await writeFile(join(dir, "enorme.txt"), "a".repeat(MAX_BYTES_ARCHIVO + 1));

    console.log("1. La lista es el proyecto");
    const lista = await archivosDelProyecto(dir);
    check("incluye src/App.tsx", lista.includes("src/App.tsx"));
    check("incluye package.json", lista.includes("package.json"));
    check("no incluye el .env", !lista.includes(".env"), JSON.stringify(lista));
    check("no incluye node_modules", !lista.some((r) => r.startsWith("node_modules/")));
    check("no incluye dist", !lista.some((r) => r.startsWith("dist/")));

    console.log("\n2. Un archivo normal se lee");
    const app = await leerArchivoDelProyecto(dir, "src/App.tsx");
    check("trae su contenido", !!app && "contenido" in app && app.contenido.includes("Hola"));

    console.log("\n3. Lo que no es del proyecto no se sirve");
    for (const ruta of [".env", "../../etc/passwd", "/etc/passwd", "node_modules/react/index.js", "src/../.env", "no-existe.ts"]) {
      check(`"${ruta}" → nada`, (await leerArchivoDelProyecto(dir, ruta)) === null);
    }

    console.log("\n4. Binarios y gigantes no se mandan como texto");
    const png = await leerArchivoDelProyecto(dir, "logo.png");
    check("la imagen sale como binaria", !!png && "binario" in png);
    const grande = await leerArchivoDelProyecto(dir, "enorme.txt");
    check("el archivo enorme sale sin contenido", !!grande && "grande" in grande && !("contenido" in grande));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  console.log(`\n${pass} pasaron, ${fail} fallaron`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
