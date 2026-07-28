import { io as ioClient, type Socket } from "socket.io-client";

/**
 * Demo: las API keys son de cada persona, no de la sala.
 * Uso: npm run demo:keys -- <roomId>
 *
 * Requiere el server SIN key de respaldo en el .env (si hay una, todos pueden
 * invocar y no se puede probar el caso "sin key"). Arráncalo así:
 *   ANTHROPIC_API_KEY= npx tsx src/index.ts
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

function conectar(roomId: string, nombre: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = ioClient(SERVER, { transports: ["websocket"] });
    const t = setTimeout(() => reject(new Error(`timeout: ${nombre}`)), 20000);
    s.on("connect", () => s.emit("join", { roomId, name: nombre }));
    s.on("joined", () => {
      clearTimeout(t);
      resolve(s);
    });
    s.on("error:join", (e: any) => {
      clearTimeout(t);
      reject(new Error(e.message));
    });
  });
}

/** Espera un evento con timeout. null si no llegó. */
function esperar(s: Socket, evento: string, ms: number): Promise<any> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    s.once(evento, (payload: any) => {
      clearTimeout(t);
      resolve(payload ?? {});
    });
  });
}

async function main() {
  const roomId = process.argv[2];
  if (!roomId) {
    console.error("uso: demo:keys -- <roomId>");
    process.exit(1);
  }

  console.log("=== Keys por persona ===\n");

  const ana = await conectar(roomId, "ana");
  const beto = await conectar(roomId, "beto");
  console.log("dos personas en la sala\n");

  console.log("1. Sin key no se puede invocar (pero sí entrar y platicar)");
  ana.emit("chat", { text: "@agente hazme algo" });
  const rechazo = await esperar(ana, "error:key", 6000);
  check("a quien no tiene key se le avisa", rechazo !== null, "no llegó error:key");

  const betoSeEntero = await esperar(beto, "error:key", 2500);
  check("y el aviso es SOLO para esa persona", betoSeEntero === null);

  console.log("\n2. La key se valida antes de guardarse");
  ana.emit("auth:key", { key: "esto-no-es-una-key" });
  const malFormato = await esperar(ana, "error:key", 5000);
  check("rechaza una key con formato inválido", malFormato !== null, "la aceptó");

  console.log("\n3. Con key válida, ya puede invocar");
  // Formato válido (no es una key real: solo prueba el camino de aceptación).
  ana.emit("auth:key", { key: "sk-ant-api03-" + "x".repeat(40) });
  const ok = await esperar(ana, "auth:ok", 5000);
  check("el server la acepta", ok !== null, "no llegó auth:ok");

  console.log("\n4. La key de una NO le sirve a la otra");
  beto.emit("chat", { text: "@agente y a mí también" });
  const betoRechazado = await esperar(beto, "error:key", 6000);
  check(
    "quien no puso key sigue sin poder invocar",
    betoRechazado !== null,
    "beto invocó con la key de ana",
  );

  console.log("\n5. Olvidar la key deja de permitir invocar");
  ana.emit("auth:forget");
  await new Promise((r) => setTimeout(r, 800));
  ana.emit("chat", { text: "@agente otra vez" });
  const trasOlvidar = await esperar(ana, "error:key", 6000);
  check("tras olvidarla, vuelve a pedirla", trasOlvidar !== null, "siguió invocando");

  ana.disconnect();
  beto.disconnect();
  console.log(`\n${pass} pasaron, ${fail} fallaron\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("falló:", e.message);
  process.exit(1);
});
