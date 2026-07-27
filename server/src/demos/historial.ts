import { io as ioClient } from "socket.io-client";

/**
 * Demo Fase 5: verifica el ciclo completo del historial.
 * Uso: npm run demo:historial -- <roomId>
 *
 * Dispara dos turnos de agente, revisa que aparezcan en la línea de tiempo,
 * pide el diff, marca un bookmark y regresa al primer punto.
 */

const SERVER = "http://localhost:4000";

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

async function history(roomId: string): Promise<any[]> {
  const r = (await fetch(`${SERVER}/rooms/${roomId}/history`).then((x) => x.json())) as {
    entries?: any[];
  };
  return r.entries ?? [];
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const roomId = process.argv[2];
  if (!roomId) {
    console.error("uso: demo:historial -- <roomId>");
    process.exit(1);
  }

  console.log("=== FASE 5 — historial ===\n");

  const socket = ioClient(SERVER, { transports: ["websocket"] });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), 15000);
    socket.on("connect", () => socket.emit("join", { roomId, name: "tester" }));
    socket.on("joined", () => {
      clearTimeout(t);
      resolve();
    });
    socket.on("error:join", (e: any) => {
      clearTimeout(t);
      reject(new Error(e.message));
    });
  });

  console.log("1. Turnos de agente → puntos en la línea de tiempo");
  const antes = await history(roomId);

  // Un solo turno basta para probar el historial. (Con el provider mock, dos
  // agentes editan el MISMO texto y el segundo choca — eso es correcto: el CAS
  // hace su trabajo. Se prueba en demo:concurrency, no aquí.)
  socket.emit("chat", { text: "@agente primer cambio" });
  // Los commits en /mnt/c (filesystem de Windows en WSL) son lentos: ~8s.
  await sleep(14000);

  const despues = await history(roomId);
  check("aparecieron puntos nuevos", despues.length > antes.length, `${antes.length} → ${despues.length}`);

  const punto = despues[0];
  check("el punto trae autor (el agente)", !!punto?.author, punto?.author ?? "");
  check("el punto trae los archivos que cambió", (punto?.files?.length ?? 0) > 0);
  check(
    "el punto sabe QUÉ se pidió (ir al mensaje del chat)",
    !!punto?.task,
    punto?.task ? `"${punto.task.slice(0, 40)}"` : "sin task",
  );

  console.log("\n2. Diff de un turno (opt-in)");
  const diff = (await fetch(`${SERVER}/rooms/${roomId}/diff/${punto.hash}`).then((x) =>
    x.json(),
  )) as { patch?: string };
  check("devuelve el patch", typeof diff.patch === "string" && diff.patch.length > 0);
  check("el patch trae líneas de cambio", /^[+-]/m.test(diff.patch ?? ""));

  console.log("\n3. Bookmarks");
  socket.emit("history:bookmark", { hash: punto.hash, label: "la que funcionaba" });
  await sleep(600);
  const conMarca = await history(roomId);
  check(
    "la marca se guardó",
    conMarca.find((e) => e.hash === punto.hash)?.bookmark === "la que funcionaba",
  );

  console.log("\n4. Regresar a un punto (commit nuevo, sin borrar historia)");
  // Hacer OTRO cambio primero, para que regresar signifique algo. (Revertir al
  // estado actual no genera commit — git no crea commits vacíos, y está bien.)
  socket.emit("chat", { text: "@agente otro cambio para poder regresar" });
  await sleep(14000);
  const conDos = await history(roomId);
  const antesDeRevert = conDos.length;

  const objetivo = conDos[conDos.length - 1]; // el más viejo
  socket.emit("history:revert", { hash: objetivo.hash });
  await sleep(14000);
  const trasRevert = await history(roomId);
  check(
    "el revert AGREGÓ un punto (no borró historia)",
    trasRevert.length > antesDeRevert,
    `${antesDeRevert} → ${trasRevert.length}`,
  );
  check("los puntos anteriores siguen ahí", trasRevert.some((e) => e.hash === punto.hash));

  socket.disconnect();
  console.log(`\n${pass} pasaron, ${fail} fallaron\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("falló:", e.message);
  process.exit(1);
});
