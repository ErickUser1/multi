import { io as ioClient, type Socket } from "socket.io-client";

/**
 * Demo: interrumpir NO borra lo que el agente ya sabía.
 * Uso: npm run demo:interrupcion -- <roomId>
 *
 * El server debe correr con:  MULTI_TEST_MOCK=1 MULTI_DEBUG=1 npx tsx src/index.ts
 * (el mock para no gastar API key; el debug para poder leer el historial)
 *
 * El bug que cubre, visto en una sesión real: al interrumpir a un agente y
 * volver a hablarle, contestaba "no tengo el contexto de la conversación
 * anterior". El historial solo se guardaba cuando el turno terminaba bien; una
 * interrupción caía al catch y se perdía todo lo del turno.
 *
 * Eso rompe la premisa de "interrumpe sin miedo": si interrumpir cuesta el
 * contexto, nadie interrumpe.
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function historialDe(roomId: string, agentId: string): Promise<number> {
  const res = await fetch(`${SERVER}/rooms/${roomId}/agents/${agentId}/history`);
  if (res.status === 404) {
    // Puede ser la sala... o que el endpoint de diagnóstico no esté montado.
    console.error(
      "\n  No pude leer el historial. Arranca el server con MULTI_DEBUG=1:\n" +
        "    MULTI_TEST_MOCK=1 MULTI_DEBUG=1 npx tsx src/index.ts\n",
    );
    process.exit(1);
  }
  const r = (await res.json()) as { messages?: unknown[] };
  return r.messages?.length ?? 0;
}

async function main() {
  const roomId = process.argv[2];
  if (!roomId) {
    console.error("uso: demo:interrupcion -- <roomId>");
    process.exit(1);
  }

  console.log("=== Interrumpir conserva el contexto ===\n");

  let agentes: any[] = [];
  const avisos: string[] = [];

  const socket: Socket = ioClient(SERVER, { transports: ["websocket"] });
  socket.on("agents", (p: any) => (agentes = p.agents ?? []));
  socket.on("chat:message", (m: any) => {
    if (m.role === "system") avisos.push(String(m.text));
  });

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

  console.log("1. Un turno normal deja historial");
  socket.emit("chat", { text: "@agente primer encargo" });
  await sleep(28000);
  const agente = agentes[0];
  check("el agente existe", !!agente, JSON.stringify(agentes.map((a) => a.id)));
  const trasTurnoNormal = await historialDe(roomId, agente.id);
  check("guardó historial", trasTurnoNormal > 0, `${trasTurnoNormal} mensajes`);

  console.log("\n2. Se interrumpe a media chamba");
  socket.emit("chat", { text: `@${agente.name} segundo encargo largo` });
  await sleep(3000);
  check("está trabajando", agentes[0]?.state !== "idle", agentes[0]?.state);

  socket.emit("chat", { text: `@${agente.name} espérate, mejor otra cosa` });
  await sleep(2000);
  check(
    "la sala ve la interrupción",
    avisos.some((t) => t.includes("interrumpió")),
    avisos.join(" | ") || "(sin avisos)",
  );

  await sleep(30000);

  console.log("\n3. Lo importante: el contexto NO se perdió");
  const trasInterrupcion = await historialDe(roomId, agente.id);
  check(
    "el historial creció en vez de perderse",
    trasInterrupcion > trasTurnoNormal,
    `${trasTurnoNormal} -> ${trasInterrupcion}`,
  );
  check(
    "no se anunció como falla del agente",
    !avisos.some((t) => t.includes("falló")),
    avisos.filter((t) => t.includes("falló")).join(" | "),
  );

  socket.disconnect();
  console.log(`\n${pass} pasaron, ${fail} fallaron\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("falló:", e.message);
  process.exit(1);
});
