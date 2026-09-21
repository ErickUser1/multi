import { rm } from "node:fs/promises";
import { getStorage } from "../storage/index.js";
import type { ModoDeSala } from "../storage/types.js";

/**
 * Demo: el modo de una sala sobrevive a que el server se reinicie.
 * Uso: npm run demo:modo-persistido
 *
 * El bug que cubre, y que estuvo vivo en 72 de las 77 salas de producción: la
 * sala nace en "solo" (`createRoom` en rooms.ts) pero el INSERT no escribía esa
 * columna, así que en disco quedaba NULL. Mientras la sala viviera en memoria
 * todo iba bien; en cuanto se releía de la base, el NULL caía a "multi" (ver
 * `toRoom`) y la sala empezaba a pedir la arroba sin que nadie tocara el botón.
 *
 * Pasaba al reiniciar el server y al despertar una sala dormida, o sea a
 * cualquiera que dejara su sala media hora sola. Y le pegaba justo a quien está
 * solo, que es para quien se hizo el modo.
 *
 * El fallback a "multi" se queda y también se prueba: las salas anteriores a la
 * columna sí traen NULL de verdad, y esas tienen que seguir comportándose como
 * siempre.
 *
 * Va contra una base temporal, así que no necesita server ni toca la de nadie.
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

async function main() {
  console.log("\n=== El modo sobrevive al reinicio ===\n");

  // Una base aparte: esto escribe y borra salas, y la de verdad tiene las de
  // todos. `MULTI_DB` lo lee `getStorage` al abrir.
  const db = `/tmp/multi-demo-modo-${Date.now()}.db`;
  process.env.MULTI_DB = db;
  const storage = await getStorage();

  const now = Date.now();
  const guardar = (id: string, modo?: ModoDeSala | null) =>
    storage.createRoom({ id, workspaceDir: `/tmp/${id}`, createdAt: now, lastActiveAt: now, modo });

  console.log("1. Una sala que nace sola sigue sola mañana");
  {
    // Lo que hace `createRoom` en rooms.ts: la sala nace de una persona.
    await guardar("sala-de-uno", "solo");
    // Y esto es releerla, que es lo que pasa al reiniciar el server o al
    // despertar una sala dormida.
    const vuelta = await storage.getRoom("sala-de-uno");
    check("vuelve en solo, no en multi", vuelta?.modo === "solo", String(vuelta?.modo));
  }

  console.log("\n2. Y una en multi también se respeta");
  {
    await guardar("sala-de-varios", "multi");
    const vuelta = await storage.getRoom("sala-de-varios");
    check("vuelve en multi", vuelta?.modo === "multi", String(vuelta?.modo));
  }

  console.log("\n3. Las salas de antes de la columna no cambian de comportamiento");
  {
    // NULL de verdad: así están las 72 salas que ya existían. El fallback es a
    // propósito y no se toca, porque esas siempre se comportaron como multi.
    await guardar("sala-vieja", null);
    const vuelta = await storage.getRoom("sala-vieja");
    check("un NULL sigue cayendo a multi", vuelta?.modo === "multi", String(vuelta?.modo));
  }

  console.log("\n4. Cambiar el modo sigue mandando sobre lo que se guardó");
  {
    await storage.setModo("sala-de-uno", "multi");
    const vuelta = await storage.getRoom("sala-de-uno");
    check("lo que se cambia queda", vuelta?.modo === "multi", String(vuelta?.modo));
  }

  console.log("\n5. Guardar el modo no se lleva por delante lo demás");
  {
    // El INSERT es `OR REPLACE`: si un día se llama dos veces con el mismo id,
    // REPLACE borra la fila y la reescribe solo con las columnas que le pasan.
    // Hoy no pasa (solo se llama al crear, con un id nuevo), y esto lo vigila.
    await storage.renameRoom("sala-de-varios", "la cafetería");
    const vuelta = await storage.getRoom("sala-de-varios");
    check(
      "el nombre y el modo conviven",
      vuelta?.nombre === "la cafetería" && vuelta?.modo === "multi",
      JSON.stringify({ nombre: vuelta?.nombre, modo: vuelta?.modo }),
    );
  }

  await rm(db, { force: true });
  await rm(`${db}-shm`, { force: true });
  await rm(`${db}-wal`, { force: true });

  console.log(`\n${pass} pasaron, ${fail} fallaron\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("la demo falló:", e);
  process.exit(1);
});
