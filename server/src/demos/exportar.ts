import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createWorkspace } from "../engine/workspace.js";
import {
  commitAll,
  exportarZip,
  hayCommits,
  tieneCambiosSinCommitear,
} from "../engine/git.js";

/**
 * Demo: llevarte el proyecto de la sala como .zip.
 * Uso: npm run demo:exportar
 *
 * Lo que importa comprobar aquí es que el zip trae el proyecto y NADA MÁS. El
 * .gitignore que siembra el motor deja node_modules y .env fuera del historial,
 * y como el zip sale de `git archive HEAD`, lo que nunca se commiteó no puede
 * colarse. Esa es justo la razón de exportar desde git y no zipeando la carpeta.
 */

const execFileP = promisify(execFile);

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

/**
 * Los nombres de archivo que trae un zip, sin depender de `unzip`.
 *
 * En el zip cada entrada empieza con la firma PK\x03\x04 y el nombre viene en
 * claro después de la cabecera de 30 bytes. Con eso basta para comprobar qué
 * entró y qué no, y el demo corre igual en una máquina sin utilidades de zip.
 */
function nombresEnZip(zip: Buffer): string[] {
  const nombres: string[] = [];
  for (let i = 0; i + 30 <= zip.length; i++) {
    if (zip.readUInt32LE(i) !== 0x04034b50) continue;
    const largoNombre = zip.readUInt16LE(i + 26);
    nombres.push(zip.subarray(i + 30, i + 30 + largoNombre).toString("utf8"));
  }
  return nombres;
}

async function main() {
  console.log("\n=== exportar la sala como .zip ===\n");

  const roomId = "demo-exportar";
  const ws = await createWorkspace(roomId, { clean: true });

  console.log("1. Una sala recién creada no tiene nada que llevarse");
  check("no hay commits todavía", (await hayCommits(ws.dir)) === false);
  const truena = await exportarZip(ws.dir).then(
    () => false,
    () => true,
  );
  check("exportar falla en vez de dar un zip vacío", truena);

  console.log("\n2. Aparece un proyecto y se cierra un turno");
  await writeFile(join(ws.dir, "index.html"), "<h1>Hola</h1>\n", "utf8");
  await mkdir(join(ws.dir, "src"), { recursive: true });
  await writeFile(join(ws.dir, "src", "app.js"), "console.log('hola')\n", "utf8");

  // La basura que NO debe viajar: pesa, no es del proyecto, y en el caso del
  // .env es un secreto. El .gitignore del motor ya la excluye.
  await mkdir(join(ws.dir, "node_modules", "una-lib"), { recursive: true });
  await writeFile(join(ws.dir, "node_modules", "una-lib", "index.js"), "// basura\n", "utf8");
  await writeFile(join(ws.dir, ".env"), "API_KEY=secreto-que-no-debe-salir\n", "utf8");

  const hash = await commitAll(ws.dir, { message: "el proyecto", author: "demo" });
  check("el turno commiteó", !!hash, String(hash));
  check("ahora sí hay commits", await hayCommits(ws.dir));

  console.log("\n3. El zip sale bien formado");
  const zip = await exportarZip(ws.dir);
  check("pesa algo", zip.length > 0, `${zip.length} bytes`);
  // Si `encoding: "buffer"` se cayera del execFile, el zip llegaría decodificado
  // como utf8 y corrupto SIN dar error. La firma PK es lo que lo delata.
  check("empieza con la firma PK de un zip", zip.subarray(0, 2).toString("latin1") === "PK");

  console.log("\n4. Trae el proyecto y nada más");
  const dentro = nombresEnZip(zip);
  check("trae index.html", dentro.includes("index.html"), dentro.join(" "));
  check("trae src/app.js", dentro.includes("src/app.js"), dentro.join(" "));
  check("NO trae node_modules", !dentro.some((f) => f.includes("node_modules")), dentro.join(" "));
  check("NO trae el .env", !dentro.some((f) => f.endsWith(".env")), dentro.join(" "));
  check("NO trae el .git", !dentro.some((f) => f.startsWith(".git/")), dentro.join(" "));

  console.log("\n5. Trabajo a medias: se avisa, no se mete al zip");
  check("con todo guardado no hay nada pendiente", (await tieneCambiosSinCommitear(ws.dir)) === false);

  await writeFile(join(ws.dir, "a-medias.txt"), "un turno sin cerrar\n", "utf8");
  check("se detecta el trabajo sin guardar", await tieneCambiosSinCommitear(ws.dir));

  const zip2 = await exportarZip(ws.dir);
  check(
    "el zip sigue siendo el último punto guardado",
    !nombresEnZip(zip2).includes("a-medias.txt"),
    nombresEnZip(zip2).join(" "),
  );

  // El zip de verdad, por si quieres abrirlo y verlo con tus ojos.
  const destino = join(ws.dir, "..", `${roomId}.zip`);
  await rm(destino, { force: true });
  await writeFile(destino, zip);
  console.log(`\n   el zip quedó en: ${destino}`);

  // Comprobación independiente: que un descompresor de verdad lo pueda abrir.
  // Si no hay unzip en la máquina, se salta en vez de fallar.
  const salida = await execFileP("unzip", ["-l", destino]).then(
    (r) => r.stdout,
    () => null,
  );
  if (salida === null) {
    console.log("   (no hay unzip en esta máquina; se omite esa comprobación)");
  } else {
    check("unzip lo abre sin quejarse", salida.includes("index.html"));
  }

  console.log(`\n${pass} pasaron, ${fail} fallaron\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\ndemo falló:", err);
  process.exit(1);
});
