import { getStorage } from "./storage/index.js";

/**
 * Moderar lo que sale en Explorar, desde el server.
 * Uso:
 *   npm run comunidad                    lista lo compartido
 *   npm run comunidad -- ocultar <sala>  lo baja de Explorar
 *   npm run comunidad -- mostrar <sala>  lo vuelve a subir
 *
 * Ocultar no borra nada: la sala, su app publicada y su chat siguen igual. Solo
 * deja de salir en Explorar, y volver a compartir no la destapa (eso lo decide
 * quien modera, no quien comparte).
 */

async function main() {
  const [accion, sala] = process.argv.slice(2);
  const storage = await getStorage();

  if (accion === "ocultar" || accion === "mostrar") {
    if (!sala) {
      console.error(`falta la sala: npm run comunidad -- ${accion} <sala>`);
      process.exit(1);
    }
    const ok = await storage.ocultarEnComunidad(sala, accion === "ocultar");
    console.log(ok ? `${sala}: ${accion === "ocultar" ? "oculta" : "visible"} en Explorar` : `${sala} no está compartida`);
    process.exit(ok ? 0 : 1);
  }

  if (accion) {
    console.error("uso: npm run comunidad [-- ocultar|mostrar <sala>]");
    process.exit(1);
  }

  const visibles = await storage.listarComunidad();
  console.log(`En Explorar: ${visibles.length}`);
  for (const c of visibles) {
    const cuando = new Date(c.compartido).toLocaleString("es-MX", { timeZone: "America/Mexico_City" });
    console.log(`  ${c.roomId.padEnd(18)} ${c.categoria.padEnd(6)} ${c.titulo}  · ${c.autor} · ${cuando}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
