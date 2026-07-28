import { io as ioClient, type Socket } from "socket.io-client";

/**
 * Demo: hablarle al agente que ya está vs. crear otro.
 * Uso: npm run demo:menciones -- <roomId>   (con MULTI_TEST_MOCK=1 en el server)
 *
 * El bug que cubre: "@agente" creaba SIEMPRE un agente nuevo, así que después de
 * dos mensajes tenías dos agentes sin saberlo, y el segundo arrancaba sin el
 * contexto del primero.
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

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const roomId = process.argv[2];
  if (!roomId) {
    console.error("uso: demo:menciones -- <roomId>");
    process.exit(1);
  }

  console.log("=== Menciones: a quién le hablas ===\n");

  let agentes: any[] = [];
  const socket: Socket = ioClient(SERVER, { transports: ["websocket"] });
  socket.on("agents", (p: any) => (agentes = p.agents ?? []));

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), 20000);
    socket.on("connect", () => socket.emit("join", { roomId, name: "tester" }));
    socket.on("joined", (p: any) => {
      agentes = p.agents ?? [];
      clearTimeout(t);
      resolve();
    });
    socket.on("error:join", (e: any) => {
      clearTimeout(t);
      reject(new Error(e.message));
    });
  });

  console.log("1. El primer @agente crea uno");
  socket.emit("chat", { text: "@agente primer encargo" });
  await sleep(25000);
  check("hay exactamente 1 agente", agentes.length === 1, `hay ${agentes.length}`);
  check("y terminó (quedó libre)", agentes[0]?.state === "idle", agentes[0]?.state);
  const primero = agentes[0]?.id;

  console.log("\n2. El segundo @agente crea OTRO (es la forma de ir en paralelo)");
  socket.emit("chat", { text: "@agente segundo encargo" });
  await sleep(25000);
  check(
    "ahora hay 2 agentes",
    agentes.length === 2,
    `hay ${agentes.length}: ${agentes.map((a) => a.id).join(", ")}`,
  );
  check("el primero sigue existiendo", agentes.some((a) => a.id === primero));

  console.log("\n3. Mencionar por NOMBRE le habla a ese, sin crear otro");
  socket.emit("chat", { text: `@${primero} tercer encargo` });
  await sleep(25000);
  check("siguen siendo 2", agentes.length === 2, `hay ${agentes.length}`);

  console.log("\n4. Otra persona puede interrumpirlo a media chamba");
  const compa: Socket = ioClient(SERVER, { transports: ["websocket"] });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout compa")), 20000);
    compa.on("connect", () => compa.emit("join", { roomId, name: "compa" }));
    compa.on("joined", () => {
      clearTimeout(t);
      resolve();
    });
  });

  const avisos: string[] = [];
  socket.on("chat:message", (m: any) => {
    if (m.role === "system") avisos.push(String(m.text));
  });

  // Yo lanzo trabajo y el compa corrige a mitad, sin esperar a que termine.
  const antesDeLanzar = agentes.length;
  socket.emit("chat", { text: "@agente ponlo rojo" });
  await sleep(3000);
  const trabajador = agentes.find((a) => a.state !== "idle");
  check("hay un agente trabajando", !!trabajador, agentes.map((a) => `${a.id}:${a.state}`).join(","));

  // Mencionarlo POR NOMBRE: eso es lo que interrumpe (@agente crearía otro).
  compa.emit("chat", { text: `@${trabajador?.name} mejor azul` });
  await sleep(2500);
  check(
    "la sala ve que lo interrumpieron",
    avisos.some((t) => t.includes("interrumpió")),
    avisos.join(" | ") || "(sin avisos)",
  );

  await sleep(30000);
  check(
    "interrumpir NO creó otro agente",
    agentes.length === antesDeLanzar + 1,
    `${antesDeLanzar} -> ${agentes.length}`,
  );
  check("todos quedaron libres", agentes.every((a) => a.state === "idle"),
    agentes.map((a) => `${a.id}:${a.state}`).join(","));

  compa.disconnect();
  socket.disconnect();
  console.log(`\n${pass} pasaron, ${fail} fallaron\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("falló:", e.message);
  process.exit(1);
});
