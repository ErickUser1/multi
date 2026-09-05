import { RunCoordinator } from "../engine/coordinator.js";
import { AgentRegistry } from "../engine/agents.js";
import { dormirSalasOciosas, type Room } from "../rooms.js";

/**
 * Verifica cuándo se duerme una sala y, sobre todo, cuándo NO.
 * Uso: MULTI_SLEEP_MIN=0.001 npm run demo:dormir
 *
 * Lo que se está protegiendo son los tres casos en los que dormir haría daño:
 *
 * - Con gente dentro, se le apagaría el preview a alguien que está mirando.
 * - Con un agente trabajando, `sweepOrphans` marcaría su turno como huérfano al
 *   despertar, y la sala le pintaría al usuario una alerta de trabajo perdido
 *   por algo que decidió el propio sistema.
 * - Instalando o publicando, se cortaría un proceso de minutos que no pasa por
 *   el coordinador y del que nadie más tiene registro.
 *
 * Las salas son de mentira a propósito: `dormirSalasOciosas` solo mira campos del
 * Room, así que no hacen falta contenedores ni dev servers para probar la
 * decisión. Lo que sí hay que probar a mano es que al despertar el preview
 * vuelve — eso está en el README de la rama.
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

/** Sala de mentira con un preview simulado, para no levantar nada real. */
function salaFalsa(id: string, opts: Partial<Room> = {}): Room {
  let parado = false;
  return {
    id,
    workspace: { roomId: id, dir: `/tmp/${id}` },
    preview: {
      roomId: id,
      port: 5200,
      url: "http://localhost:5200",
      process: null as never,
      stop: async () => {
        parado = true;
      },
      // Marca para poder afirmar que se paró de verdad, no solo que se olvidó.
      get parado() {
        return parado;
      },
    } as never,
    members: new Map(),
    histories: new Map(),
    selections: new Map(),
    agents: new AgentRegistry(),
    coordinator: new RunCoordinator(),
    // Vacía desde hace rato: el umbral se baja por entorno al correr la demo.
    vaciaDesde: Date.now() - 60 * 60_000,
    ...opts,
  } as Room;
}

/**
 * Mete las salas en el Map del módulo.
 *
 * `rooms` es privado a propósito (nadie de fuera debería poder plantar salas),
 * así que la demo entra por `createRoom`… que crearía workspaces de verdad. En
 * vez de eso se prueba la FUNCIÓN de decisión con salas armadas a mano, que es
 * lo que interesa: qué duerme y qué no.
 */
async function main(): Promise<void> {
  console.log("=== Dormir salas ociosas ===\n");

  const umbral = Number(process.env.MULTI_SLEEP_MIN ?? 30);
  if (umbral > 1) {
    console.error(
      `El umbral está en ${umbral} minutos: la demo esperaría una hora.\n` +
        `Corre: MULTI_SLEEP_MIN=0.001 npm run demo:dormir`,
    );
    process.exit(1);
  }

  const { allRooms } = await import("../rooms.js");
  const antes = allRooms().length;
  if (antes > 0) {
    console.log(`  (hay ${antes} sala(s) en memoria; la demo solo mira las suyas)\n`);
  }

  console.log("1. Una sala vacía y ociosa se duerme");
  const vacia = salaFalsa("_dormir-vacia");
  await probar([vacia]);
  check("se durmió", vacia.preview === null);

  console.log("\n2. Con gente dentro NO se duerme");
  const conGente = salaFalsa("_dormir-con-gente");
  conGente.members.set("socket-1", { socketId: "socket-1" } as never);
  conGente.vaciaDesde = undefined;
  await probar([conGente]);
  check("sigue despierta", conGente.preview !== null);

  console.log("\n3. Con un agente trabajando NO se duerme, aunque esté vacía");
  const trabajando = salaFalsa("_dormir-trabajando");
  // Un drain vivo es lo que `activeKeys()` reporta como trabajo en curso.
  let soltar!: () => void;
  const enVuelo = new Promise<void>((r) => {
    soltar = r;
  });
  void trabajando.coordinator.run("_dormir-trabajando:agente-1", () => enVuelo);
  await new Promise((r) => setTimeout(r, 10));
  check(
    "el coordinador lo ve trabajando",
    trabajando.coordinator.activeKeys().length === 1,
    `${trabajando.coordinator.activeKeys().length} activos`,
  );
  await probar([trabajando]);
  check("sigue despierta", trabajando.preview !== null);
  soltar();

  console.log("\n4. Instalando dependencias NO se duerme");
  const instalando = salaFalsa("_dormir-instalando", { previewBooting: true });
  await probar([instalando]);
  check("sigue despierta", instalando.preview !== null);

  console.log("\n5. Publicando NO se duerme");
  const publicando = salaFalsa("_dormir-publicando", { publicando: "compilando" });
  await probar([publicando]);
  check("sigue despierta", publicando.preview !== null);

  console.log("\n6. Una sala recién vaciada NO se duerme todavía");
  const reciente = salaFalsa("_dormir-reciente", { vaciaDesde: Date.now() });
  await probar([reciente]);
  check("sigue despierta", reciente.preview !== null);

  console.log("\n7. Una sala ya dormida no se vuelve a dormir");
  const yaDormida = salaFalsa("_dormir-ya", { preview: null });
  const durmio = await probar([yaDormida]);
  check("no cuenta como dormida otra vez", durmio === 0, `durmió ${durmio}`);

  console.log(`\n${pass} ok, ${fail} fallos`);
  process.exit(fail > 0 ? 1 : 0);
}

/** Corre el barrido contra un conjunto de salas de mentira. */
async function probar(salas: Room[]): Promise<number> {
  const { __roomsParaPruebas: mapa } = await import("../rooms.js");
  mapa.clear();
  for (const s of salas) mapa.set(s.id, s);
  const n = await dormirSalasOciosas();
  mapa.clear();
  return n;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
