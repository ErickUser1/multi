import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createWorkspace } from "../engine/workspace.js";
import {
  isDockerAvailable,
  ensureImage,
  startContainer,
  stopContainer,
} from "../engine/container.js";
import { containerRunner, localRunner } from "../engine/runner.js";

/**
 * Demo Fase 7b: verifica que el agente NO puede salirse de su sala.
 * Uso: npm run demo:aislamiento
 *
 * El punto: las tools de archivos ya validan la ruta (safePath), pero bash no
 * puede — a un shell le das cwd, que dice dónde EMPIEZA, no hasta dónde LLEGA.
 * Esta demo prueba las dos cosas: que sin contenedor bash SÍ se sale (por eso
 * existe la fase), y que con contenedor ya no.
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

const OPTS = { timeoutMs: 60_000, maxOutput: 8000 };

async function main() {
  console.log("=== FASE 7b — aislamiento por sala ===\n");

  if (!(await isDockerAvailable())) {
    console.error("Docker no disponible: esta demo lo necesita.");
    process.exit(1);
  }

  const roomId = "demo-aislamiento";
  const ws = await createWorkspace(roomId, { clean: true });

  console.log("1. Sin contenedor, bash SÍ se sale del workspace (el problema)");
  const local = localRunner(ws.dir);
  const fuera = await local.exec("cd .. && pwd", OPTS);
  const salioDelWorkspace = !fuera.stdout.trim().endsWith(roomId);
  check(
    "un `cd ..` deja el workspace",
    salioDelWorkspace,
    `quedó en ${fuera.stdout.trim()}`,
  );

  const home = await local.exec("ls ~ 2>/dev/null | head -3", OPTS);
  check("alcanza el home de la máquina", home.stdout.trim().length > 0, "(no había nada que listar)");

  console.log("\n2. Con contenedor, el mismo comando ya no llega a ningún lado");
  await ensureImage(join(process.cwd(), ".."));
  await startContainer(roomId, ws.dir, 5173);
  const dentro = containerRunner(roomId);

  const arriba = await dentro.exec("cd .. && ls", OPTS);
  // Adentro, subir de /work lleva a la raíz del contenedor: un Linux vacío,
  // no el disco de nadie. La prueba real es que NO están los archivos del host.
  check(
    "arriba de /work no está el repo de Multi",
    !arriba.stdout.includes("DESIGN.md") && !arriba.stdout.includes("multijugador"),
    arriba.stdout.replace(/\n/g, " ").slice(0, 80),
  );

  const marcaHost = join(homedir(), ".multi-marca-aislamiento");
  await writeFile(marcaHost, "esto vive en el host", "utf8");
  const intento = await dentro.exec(`cat ${marcaHost} 2>&1`, OPTS);
  check(
    "no puede leer un archivo del home del host",
    !intento.stdout.includes("esto vive en el host"),
    intento.stdout.trim().slice(0, 60),
  );

  console.log("\n3. Lo escrito fuera de /work NO aparece en el disco del host");
  await dentro.exec("echo 'fuga' > /tmp/fuga-de-la-sala.txt", OPTS);
  const dentroLoVe = await dentro.exec("cat /tmp/fuga-de-la-sala.txt", OPTS);
  check("adentro sí existe", dentroLoVe.stdout.includes("fuga"));
  check("en el host no existe", !existsSync("/tmp/fuga-de-la-sala.txt"));

  console.log("\n4. Pero el workspace SÍ es compartido (por eso git sigue jalando)");
  await dentro.exec("echo 'hola desde el contenedor' > saludo.txt", OPTS);
  const enElHost = existsSync(join(ws.dir, "saludo.txt"))
    ? await readFile(join(ws.dir, "saludo.txt"), "utf8")
    : "";
  check(
    "un archivo escrito adentro aparece en el disco del host",
    enElHost.includes("hola desde el contenedor"),
    enElHost.trim(),
  );

  console.log("\n5. El agente puede instalar lo que necesite");
  const python = await dentro.exec("python3 -c 'print(2+2)'", OPTS);
  check("corre python (venía en la imagen)", python.stdout.trim() === "4", python.stdout.trim());

  const git = await dentro.exec("git --version", OPTS);
  check("tiene git", git.stdout.includes("git version"), git.stdout.trim());

  console.log("\n6. Al cerrar la sala, el contenedor desaparece");
  await stopContainer(roomId);
  const muerto = await dentro.exec("echo sigue vivo", OPTS).catch(() => null);
  check(
    "ya no se puede ejecutar nada",
    muerto === null || muerto.code !== 0,
    muerto ? `code ${muerto.code}` : "",
  );

  console.log(`\n${pass} pasaron, ${fail} fallaron\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("falló:", e);
  process.exit(1);
});
