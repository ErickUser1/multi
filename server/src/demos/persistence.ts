import { io as ioClient } from "socket.io-client";

/**
 * Demo Fase 7a: verifica que una sala sobrevive al reinicio del server.
 * Uso: npm run demo:persistence -- <roomId>
 *
 * Se corre DOS veces: antes de matar el server (escribe) y después (verifica).
 */

const SERVER = "http://localhost:4000";

function connect(roomId: string, name: string): Promise<{ socket: any; joined: any }> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(SERVER, { transports: ["websocket"] });
    const t = setTimeout(() => reject(new Error("timeout al conectar")), 15000);
    socket.on("connect", () => socket.emit("join", { roomId, name }));
    socket.on("joined", (joined: any) => {
      clearTimeout(t);
      resolve({ socket, joined });
    });
    socket.on("error:join", (e: any) => {
      clearTimeout(t);
      reject(new Error(e.message));
    });
  });
}

async function main() {
  const roomId = process.argv[2];
  const mode = process.argv[3] ?? "write";
  if (!roomId) {
    console.error("uso: demo:persistence -- <roomId> [write|verify]");
    process.exit(1);
  }

  const { socket, joined } = await connect(roomId, "tester");

  if (mode === "write") {
    console.log(`conectado a ${roomId}`);
    socket.emit("chat", { text: "mensaje antes del reinicio" });
    socket.emit("chat", { text: "otro mensaje de prueba" });
    await new Promise((r) => setTimeout(r, 800));
    console.log("2 mensajes enviados. Ahora mata el server y corre con 'verify'.");
  } else {
    const msgs = joined.messages ?? [];
    console.log(`\n=== VERIFICACIÓN TRAS EL REINICIO ===`);
    console.log(`sala encontrada: ${joined.roomId}`);
    console.log(`mensajes recuperados: ${msgs.length}`);
    msgs.forEach((m: any) => console.log(`  [${m.role}] ${m.from}: ${m.text}`));
    const ok = msgs.length >= 2;
    console.log(`\n${ok ? "[ok] la sala y su chat SOBREVIVIERON" : "[X] se perdió el historial"}`);
    socket.disconnect();
    process.exit(ok ? 0 : 1);
  }

  socket.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error("falló:", e.message);
  process.exit(1);
});
