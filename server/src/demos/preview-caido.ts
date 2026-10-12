import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunCoordinator } from "../engine/coordinator.js";
import { AgentRegistry } from "../engine/agents.js";
import type { Room } from "../rooms.js";

/**
 * Demo: la vista previa se vuelve a levantar cuando se cae sola.
 * Uso: npm run demo:preview-caido
 *
 * El bug que cubre: un agente limpió sus procesos de prueba con
 * `pkill -f "python3 app.py"` y se llevó también el dev server de la sala. La
 * sala guardaba la URL del proceso muerto, `arrancarPreview` la devolvía como
 * viva, y nadie la volvía a levantar: dos horas de "error de red".
 *
 * Corre sin Docker y sin red: el runner local y un servidor de Node de diez
 * líneas, que es lo mínimo que `detectLaunch` reconoce como proyecto.
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

/** Un proyecto que Multi sabe arrancar: escucha en PORT y anota su PID. */
async function proyectoMinimo(dir: string): Promise<void> {
  const pkg = JSON.stringify({ name: "caido", private: true, scripts: { dev: "node server.js" } });
  await writeFile(join(dir, "package.json"), pkg);
  await writeFile(
    join(dir, "server.js"),
    [
      `require("fs").writeFileSync(__dirname + "/server.pid", String(process.pid));`,
      `require("http").createServer((_, r) => r.end("vivo")).listen(process.env.PORT, "127.0.0.1");`,
    ].join("\n"),
  );
  // Que `arrancarPreview` no corra `npm install`: sin dependencias no hay nada
  // que instalar, y así la demo no depende de la red. Es la misma huella que
  // calcula rooms.ts.
  await mkdir(join(dir, "node_modules"), { recursive: true });
  const huella = createHash("sha256").update(pkg).digest("hex");
  await writeFile(join(dir, "node_modules", ".multi-deps"), huella);
}

function salaCon(dir: string, id: string): Room {
  return {
    id,
    workspace: { roomId: id, dir },
    preview: null,
    members: new Map([["socket-1", { socketId: "socket-1" } as never]]),
    histories: new Map(),
    selections: new Map(),
    agents: new AgentRegistry(),
    coordinator: new RunCoordinator(),
  } as unknown as Room;
}

async function responde(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return (await r.text()) === "vivo";
  } catch {
    return false;
  }
}

/** Mata el servidor del proyecto como lo haría un `pkill`: por fuera de Multi. */
async function matarDesdeFuera(dir: string): Promise<void> {
  const pid = Number(await readFile(join(dir, "server.pid"), "utf8"));
  process.kill(pid, "SIGKILL");
}

async function main(): Promise<void> {
  console.log("=== La vista previa se levanta sola ===\n");
  process.env.MULTI_SIN_AISLAMIENTO = "1";

  const { maybeStartPreview, alCaerPreview, dormirSala, CAIDAS_PARA_RENDIRSE } = await import(
    "../rooms.js"
  );

  const dir = await mkdtemp(join(tmpdir(), "multi-caido-"));
  await proyectoMinimo(dir);
  const room = salaCon(dir, "_preview-caido");

  // El hook que en el server real vive en index.ts. Aquí solo se anota.
  const avisos: { seRinde: boolean }[] = [];
  let siguienteAviso: () => void = () => {};
  alCaerPreview((_room, info) => {
    avisos.push(info);
    siguienteAviso();
  });
  const esperarAviso = (ms = 5000) =>
    new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), ms);
      siguienteAviso = () => {
        clearTimeout(t);
        resolve(true);
      };
    });

  try {
    console.log("1. Arranca y responde");
    const url1 = await maybeStartPreview(room);
    check("devolvió URL", url1 !== null);
    check("responde", url1 !== null && (await responde(url1)));

    console.log("\n2. Se cae por fuera: la sala suelta la URL muerta y avisa");
    let llego = esperarAviso();
    await matarDesdeFuera(dir);
    check("llegó el aviso de caída", await llego);
    check("room.preview quedó en null", room.preview === null);
    check("no se rinde a la primera", avisos.at(-1)?.seRinde === false);

    console.log("\n3. Se vuelve a levantar (antes devolvía la URL muerta)");
    const url2 = await maybeStartPreview(room);
    check("devolvió URL", url2 !== null);
    check("responde", url2 !== null && (await responde(url2)));

    console.log("\n4. Pararla a propósito (dormir la sala) NO cuenta como caída");
    const antes = avisos.length;
    await dormirSala(room);
    await new Promise((r) => setTimeout(r, 1000));
    check("sin aviso", avisos.length === antes, `${avisos.length - antes} aviso(s) de más`);
    check("room.preview en null", room.preview === null);

    console.log(`\n5. ${CAIDAS_PARA_RENDIRSE} caídas seguidas: se rinde en vez de dar vueltas`);
    room.caidasPreview = [];
    for (let i = 1; i <= CAIDAS_PARA_RENDIRSE; i++) {
      await maybeStartPreview(room);
      llego = esperarAviso();
      await matarDesdeFuera(dir);
      await llego;
    }
    check("la última caída dice seRinde", avisos.at(-1)?.seRinde === true);
    check(
      "las anteriores no",
      avisos.slice(-CAIDAS_PARA_RENDIRSE, -1).every((a) => !a.seRinde),
    );
  } finally {
    await room.preview?.stop().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }

  console.log(`\n${pass} pasaron, ${fail} fallaron`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
