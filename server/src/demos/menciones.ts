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

  console.log("\n2. El segundo @agente le habla AL MISMO, no crea otro");
  socket.emit("chat", { text: "@agente segundo encargo" });
  await sleep(25000);
  check(
    "sigue habiendo 1 agente",
    agentes.length === 1,
    `hay ${agentes.length}: ${agentes.map((a) => a.id).join(", ")}`,
  );
  check("y es el mismo de antes", agentes[0]?.id === primero, `${primero} vs ${agentes[0]?.id}`);

  console.log("\n3. Mencionarlo por nombre también funciona");
  socket.emit("chat", { text: `@${agentes[0].name} tercer encargo` });
  await sleep(25000);
  check("no se creó otro", agentes.length === 1, `hay ${agentes.length}`);

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
  socket.emit("chat", { text: "@agente ponlo rojo" });
  await sleep(3000);
  const trabajando = agentes.some((a) => a.state !== "idle");
  check("el agente está trabajando", trabajando, agentes.map((a) => a.state).join(","));

  compa.emit("chat", { text: `@${agentes[0].name} mejor azul` });
  await sleep(2000);
  check(
    "la sala ve que lo interrumpieron",
    avisos.some((t) => t.includes("interrumpió")),
    avisos.join(" | ") || "(sin avisos)",
  );

  await sleep(30000);
  check("el agente terminó y quedó libre", agentes[0]?.state === "idle", agentes[0]?.state);
  check("y sigue habiendo uno solo", agentes.length === 1, `hay ${agentes.length}`);

  compa.disconnect();
  socket.disconnect();
  console.log(`\n${pass} pasaron, ${fail} fallaron\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("falló:", e.message);
  process.exit(1);
});
