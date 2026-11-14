import { io as ioClient, type Socket } from "socket.io-client";

/**
 * Demo: una persona sola no vuelve multijugador su propia sala.
 * Uso: npm run demo:una-persona   (con el server corriendo: npm run dev:test)
 *
 * El bug que se vio: alguien solo en su sala, renombrándola, y de repente
 * "ahora hay más de una persona en la sala, así que para pedirle algo al agente
 * hay que escribir @agente". La sala contaba sockets, no personas: cuando la
 * conexión se cae sin avisar (wifi que cambia, laptop que se duerme, celular en
 * segundo plano) la Sala reconecta con un socket nuevo, y el viejo sigue en la
 * sala hasta que el server deja de recibirle pings, casi un minuto. En ese rato
 * había "dos" miembros, y el modo subía a multi para no bajar nunca.
 *
 * Lo mismo con dos pestañas de la misma sala: sigue siendo una persona.
 */

const SERVER = process.env.SERVER ?? "http://localhost:4000";

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

interface Entrada {
  s: Socket;
  modo: string;
  avisos: string[];
  modos: string[];
}

function entrar(roomId: string, name: string, clienteId: string): Promise<Entrada> {
  return new Promise((resolve, reject) => {
    const s = ioClient(SERVER, { transports: ["websocket"], forceNew: true, reconnection: false });
    const e: Entrada = { s, modo: "", avisos: [], modos: [] };
    const t = setTimeout(() => reject(new Error(`timeout: ${name}`)), 15000);
    s.on("connect", () => s.emit("join", { roomId, name, clienteId }));
    s.on("room:modo", ({ modo }: { modo: string }) => e.modos.push(modo));
    s.on("chat:message", (m: { role?: string; text?: string }) => {
      if (m.role === "system" && m.text) e.avisos.push(m.text);
    });
    s.on("joined", (p: { modo: string }) => {
      clearTimeout(t);
      e.modo = p.modo;
      resolve(e);
    });
    s.on("error:join", (err: { message: string }) => {
      clearTimeout(t);
      reject(new Error(err.message));
    });
  });
}

/**
 * La conexión se queda muda sin cerrarse: el socket deja de leer, así que el
 * server no se entera de que se fue hasta que fallen sus pings. Es lo que hace
 * una red que cambia o una laptop que se duerme.
 */
function congelar(e: Entrada): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tcp = (e.s.io.engine.transport as any).ws?._socket;
  tcp?.pause();
}

const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hablaDeMulti = (avisos: string[]) => avisos.some((a) => a.includes("más de una persona"));

async function salaNueva(): Promise<string> {
  const res = await fetch(`${SERVER}/rooms`, { method: "POST" });
  return ((await res.json()) as { id: string }).id;
}

async function main() {
  console.log("\n=== una persona sola sigue siendo una persona ===\n");

  console.log("1. La conexión se cae sin avisar y la Sala reconecta");
  {
    const sala = await salaNueva();
    const primera = await entrar(sala, "Donscanor", "cliente-don");
    check("entra en modo de una persona", primera.modo === "solo", `(modo ${primera.modo})`);
    congelar(primera);
    const segunda = await entrar(sala, "Donscanor", "cliente-don");
    await pausa(500);
    check("al reconectar la sala sigue en solo", segunda.modo === "solo" && !segunda.modos.includes("multi"), `(modos ${JSON.stringify(segunda.modos)})`);
    check("y no le dice que hay más de una persona", !hablaDeMulti(segunda.avisos), JSON.stringify(segunda.avisos));
    primera.s.disconnect();
    segunda.s.disconnect();
  }

  console.log("\n2. La misma persona con dos pestañas");
  {
    const sala = await salaNueva();
    const a = await entrar(sala, "Ana", "cliente-ana");
    const b = await entrar(sala, "Ana", "cliente-ana");
    await pausa(500);
    check("la segunda pestaña no la vuelve multi", !a.modos.includes("multi") && b.modo === "solo", `(modos ${JSON.stringify(a.modos)})`);
    check("sin aviso de @agente", !hablaDeMulti(a.avisos));
    a.s.disconnect();
    b.s.disconnect();
  }

  console.log("\n3. Y cuando sí llega otra persona, cambia como siempre");
  {
    const sala = await salaNueva();
    const ana = await entrar(sala, "Ana", "cliente-ana");
    const beto = await entrar(sala, "Beto", "cliente-beto");
    await pausa(500);
    check("Beto entra y la sala pasa a multi", ana.modos.includes("multi"), `(modos ${JSON.stringify(ana.modos)})`);
    check("con el aviso de @agente", hablaDeMulti(ana.avisos));
    ana.s.disconnect();
    beto.s.disconnect();
  }

  console.log("\n4. Dos personas sin cuenta que se llaman igual siguen siendo dos");
  {
    const sala = await salaNueva();
    const una = await entrar(sala, "anónimo", "cliente-uno");
    const otra = await entrar(sala, "anónimo", "cliente-otro");
    await pausa(500);
    check("la sala pasa a multi", una.modos.includes("multi"), `(modos ${JSON.stringify(una.modos)})`);
    una.s.disconnect();
    otra.s.disconnect();
  }

  console.log(`\n${pass} ok, ${fail} fallaron\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
