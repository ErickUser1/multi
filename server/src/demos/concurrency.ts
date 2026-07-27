import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileMutation, StaleContentError } from "../engine/file-mutation.js";
import { RunCoordinator } from "../engine/coordinator.js";
import { parseIntent } from "../rooms.js";

/**
 * Demo Fase 4a: verifica los tres mecanismos de concurrencia sin tocar la sala.
 * Uso: npm run demo:concurrency
 */

const TMP = join(process.cwd(), "..", "workspaces", "_test-concurrency");

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

async function testCAS() {
  console.log("\n1. CAS por archivo");
  const f = join(TMP, "app.jsx");
  await writeFile(f, "original", "utf8");

  // Escritura con expected correcto → pasa
  await fileMutation.writeIfUnchanged({
    path: f,
    content: "cambio-1",
    expected: "original",
    agentId: "agente-1",
  });
  check("escribe cuando el archivo no cambió", (await readFile(f, "utf8")) === "cambio-1");

  // Escritura con expected viejo → falla con StaleContentError
  let stale: StaleContentError | null = null;
  try {
    await fileMutation.writeIfUnchanged({
      path: f,
      content: "cambio-2",
      expected: "original", // viejo: el archivo ya dice cambio-1
      agentId: "agente-2",
    });
  } catch (e) {
    stale = e instanceof StaleContentError ? e : null;
  }
  check("rechaza cuando el archivo cambió", stale !== null);
  check(
    "el error dice QUIÉN lo tocó (mejora sobre OpenCode)",
    !!stale?.message.includes("agente-1"),
    stale?.message ?? "",
  );
  check("el mensaje instruye al modelo qué hacer", !!stale?.message.includes("read_file"));
  check("el archivo NO se pisó", (await readFile(f, "utf8")) === "cambio-1");
}

async function testParallelDistinctFiles() {
  console.log("\n2. Archivos distintos → paralelo real (no se estorban)");
  const orden: string[] = [];

  await Promise.all([
    fileMutation.writeIfUnchanged({
      path: join(TMP, "a.txt"),
      content: "A",
      agentId: "agente-1",
      onWait: () => orden.push("a-esperó"),
    }),
    fileMutation.writeIfUnchanged({
      path: join(TMP, "b.txt"),
      content: "B",
      agentId: "agente-2",
      onWait: () => orden.push("b-esperó"),
    }),
  ]);

  check("ninguno esperó al otro", orden.length === 0, `esperas: ${orden.join(",")}`);
  check("ambos escribieron", (await readFile(join(TMP, "a.txt"), "utf8")) === "A");
}

async function testSameFileQueues() {
  console.log("\n3. Mismo archivo → hacen fila (mutex por ruta)");
  const f = join(TMP, "shared.txt");
  await writeFile(f, "", "utf8");
  const esperas: string[] = [];

  await Promise.all([
    fileMutation.writeIfUnchanged({ path: f, content: "1", agentId: "agente-1" }),
    fileMutation.writeIfUnchanged({
      path: f,
      content: "2",
      agentId: "agente-2",
      onWait: (holder) => esperas.push(holder ?? "?"),
    }),
  ]);

  check("el segundo esperó al primero", esperas.length > 0, `esperas: ${esperas.length}`);
  check("sabe a QUIÉN espera (para la UI)", esperas[0]?.startsWith("agente") ?? false, esperas[0] ?? "");
}

async function testCoordinator() {
  console.log("\n4. Coordinador: join + coalescing");
  const coord = new RunCoordinator();
  let ejecuciones = 0;

  const drain = async () => {
    ejecuciones++;
    await new Promise((r) => setTimeout(r, 60));
  };

  // 4 llamadas casi simultáneas a la MISMA clave
  const all = [coord.run("agente-1", drain), coord.run("agente-1", drain), coord.run("agente-1", drain), coord.run("agente-1", drain)];
  await Promise.all(all);

  check(
    "4 mensajes → 2 ejecuciones (1 activa + 1 coalescida), no 4",
    ejecuciones === 2,
    `fueron ${ejecuciones}`,
  );

  // Claves distintas → de verdad en paralelo
  let a = 0;
  let b = 0;
  const t0 = Date.now();
  await Promise.all([
    coord.run("agente-A", async () => {
      a++;
      await new Promise((r) => setTimeout(r, 80));
    }),
    coord.run("agente-B", async () => {
      b++;
      await new Promise((r) => setTimeout(r, 80));
    }),
  ]);
  const dur = Date.now() - t0;
  check("agentes distintos corren EN PARALELO", dur < 150, `tardó ${dur}ms (secuencial sería ~160)`);
  check("ambos ejecutaron", a === 1 && b === 1);
}

function testIntents() {
  console.log("\n5. @agente separa plática de orden");
  check("texto normal = plática", parseIntent("we qué opinas?", false).kind === "talk");
  check("@agente = agente nuevo", parseIntent("@agente haz el menú", false).kind === "spawn");
  const addressed = parseIntent("@agente-2 ponlo azul", false);
  check("@agente-2 = dirigido a ese agente", addressed.kind === "address");
  check(
    "extrae el nombre del agente",
    addressed.kind === "address" && addressed.agentName === "agente-2",
  );
  check("con anclaje = orden aunque no haya @", parseIntent("ponlo azul", true).kind === "spawn");
}

async function main() {
  console.log("=== FASE 4a — concurrencia segura ===");
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });

  await testCAS();
  await testParallelDistinctFiles();
  await testSameFileQueues();
  await testCoordinator();
  testIntents();

  await rm(TMP, { recursive: true, force: true });

  console.log(`\n${pass} pasaron, ${fail} fallaron\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("demo falló:", e);
  process.exit(1);
});
