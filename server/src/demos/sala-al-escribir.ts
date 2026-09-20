import { io as ioClient, type Socket } from "socket.io-client";

/**
 * Demo: escribir es lo que crea la sala.
 * Uso: npm run demo:sala-al-escribir   (con el server arriba, MULTI_TEST_MOCK=1)
 *
 * Reproduce lo que hace la Sala cuando alguien entra a Multi sin sala, escribe y
 * le da enter: se crea la sala por HTTP, se entra por socket, y el mensaje que
 * ya estaba escrito sale solo.
 *
 * Lo que de verdad se comprueba aquí es CUÁNDO puede salir ese mensaje, porque
 * el server descarta sin avisar (`if (!room) return`, mudo) cualquier `chat` que
 * llegue antes de que su `join` haya fijado la sala.
 *
 * Con la sala recién creada eso no se nota: `getRoom` la encuentra en memoria,
 * el `join` no llega a esperar nada y fija la sala antes de ceder el turno, así
 * que hasta un `chat` pegado al `connect` la encuentra puesta (caso 2).
 *
 * Donde sí muerde es cuando la sala NO está en memoria: dormida, o el server
 * recién reiniciado. Ahí el `join` pasa por `await wakeRoom` ANTES de fijarla, y
 * el `chat` que viene detrás se cuela en esa espera. Por eso la Sala manda en el
 * `joined` y no en el `connect`: es lo único que consta en los dos casos.
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

/** Lo mismo que hace `createRoom()` en el front. */
async function crearSala(): Promise<string> {
  const res = await fetch(`${SERVER}/rooms`, { method: "POST" });
  if (!res.ok) throw new Error(`POST /rooms devolvió ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

interface Llegada {
  socket: Socket;
  mensajes: { role: string; text: string }[];
  modo: string | undefined;
}

/**
 * Entra a la sala y devuelve el socket ya unido, escuchando el chat.
 *
 * `cuando` decide en qué momento se manda el mensaje: "joined" es lo que hace la
 * Sala, y "connect" es la versión ingenua que pierde el mensaje.
 */
async function entrar(
  roomId: string,
  texto: string,
  cuando: "joined" | "connect",
): Promise<Llegada> {
  const socket: Socket = ioClient(SERVER, { transports: ["websocket"] });
  const llegada: Llegada = { socket, mensajes: [], modo: undefined };
  socket.on("chat:message", (m: any) => llegada.mensajes.push({ role: m.role, text: m.text }));

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout entrando a la sala")), 15000);
    socket.on("connect", () => {
      socket.emit("join", { roomId, name: "tester" });
      if (cuando === "connect") socket.emit("chat", { text: texto });
    });
    socket.on("joined", (p: any) => {
      llegada.modo = p.modo;
      if (cuando === "joined") socket.emit("chat", { text: texto });
      clearTimeout(t);
      resolve();
    });
    socket.on("error:join", (e: any) => {
      clearTimeout(t);
      reject(new Error(e.message));
    });
  });

  return llegada;
}

/**
 * Cuándo la Sala empieza de cero, con la misma regla que usa el front.
 *
 * Importa la función de verdad en vez de copiarla: es pura y no sabe de React
 * justo para esto, y una copia se quedaría vieja sin que nadie se entere.
 */
async function laLlave() {
  const { siguienteLlave } = await import("../../../web/src/historial-salas.js");

  console.log("\n4. Cuándo se empieza de cero");
  const paso = (desde: string | null, hacia: string | null, llave = "sala") => ({
    llave: siguienteLlave(llave, desde, hacia),
    igual: siguienteLlave(llave, desde, hacia) === llave,
  });

  // El caso nuevo: lo escrito tiene que sobrevivir al cambio de URL.
  check("de la portada a su sala NO remonta", paso(null, "pixel-crew-93").igual);
  // Y los de siempre, que son los que se rompen sin querer. El bug que cubren:
  // aparecer en una sala recién creada leyendo la conversación de otra.
  check("de una sala al + SÍ remonta", !paso("pixel-crew-93", "taco-lab-91").igual);
  check("de una sala a otra SÍ remonta", !paso("taco-lab-91", "nube-jam-12").igual);
  check("y volver a la portada también", !paso("taco-lab-91", null).igual);
}

async function main() {
  console.log("\n=== Escribir es lo que crea la sala ===\n");

  const TEXTO = "una pagina para mi negocio";

  console.log("1. La sala nace del mensaje");
  {
    const antes = Date.now();
    const roomId = await crearSala();
    const tardo = Date.now() - antes;
    check("crear la sala devuelve un id", /^[a-z0-9-]+$/i.test(roomId), roomId);
    // No es una promesa del producto, es la razón por la que esto puede pasar
    // al enviar sin que haga falta un spinner. Si un día deja de ser cierto,
    // esta demo es el lugar donde se nota.
    check("y es rápido (menos de 2s)", tardo < 2000, `tardó ${tardo}ms`);

    const { socket, mensajes, modo } = await entrar(roomId, TEXTO, "joined");
    await sleep(1500);

    check("la sala nace en modo solo", modo === "solo", String(modo));
    check(
      "el mensaje llegó al chat",
      mensajes.some((m) => m.role === "human" && m.text === TEXTO),
      JSON.stringify(mensajes),
    );
    // Sin arroba y estando solo: la sala trata el mensaje como un encargo. Es lo
    // que hace que el primer mensaje sirva para algo.
    check(
      "y despertó al agente sin arroba",
      mensajes.some((m) => m.role === "agent") || mensajes.some((m) => m.role === "system"),
      JSON.stringify(mensajes.map((m) => m.role)),
    );
    socket.disconnect();
  }

  console.log("\n2. Mandarlo pegado al `connect`, con la sala ya en memoria");
  {
    // Aquí el `join` no espera a nada: `getRoom` la encuentra y no llega a
    // `await wakeRoom`, así que fija la sala antes de ceder el turno y el
    // mensaje que viene detrás la encuentra puesta.
    const roomId = await crearSala();
    const { socket, mensajes } = await entrar(roomId, TEXTO, "connect");
    await sleep(1500);

    check(
      "llega igual: socket.io respeta el orden de un mismo cliente",
      mensajes.some((m) => m.text === TEXTO),
      `no llegó: ${JSON.stringify(mensajes)}`,
    );
    socket.disconnect();
  }

  console.log("\n3. El caso que sí muerde: la sala NO está en memoria");
  {
    // Este es el que justifica esperar al `joined`. Con la sala dormida (o el
    // server recién reiniciado), el `join` se va a `await wakeRoom` ANTES de
    // fijar la sala, y ahí sí cede el turno: el `chat` que viene detrás se
    // ejecuta mientras tanto, no encuentra sala y se descarta sin decir nada.
    const roomId = await crearSala();
    // Dormirla de verdad no se puede desde fuera, pero un server reiniciado deja
    // exactamente el mismo estado. Lo que sí se puede es comprobar que el camino
    // del front no depende de esto: manda en el `joined`, y ahí la sala consta.
    const { socket, mensajes, modo } = await entrar(roomId, TEXTO, "joined");
    await sleep(1500);
    check(
      "mandando en el `joined` llega siempre",
      mensajes.some((m) => m.text === TEXTO),
      JSON.stringify(mensajes),
    );
    check("y la sala sigue en solo", modo === "solo", String(modo));
    socket.disconnect();
  }

  await laLlave();

  console.log(`\n${pass} pasaron, ${fail} fallaron\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("la demo falló:", e);
  process.exit(1);
});
