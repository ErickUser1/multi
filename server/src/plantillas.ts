import { readFile } from "node:fs/promises";
import { getStorage } from "./storage/index.js";
import { TIPOS_DE_PLANTILLA, type TipoDePlantilla } from "./storage/types.js";

/**
 * Las plantillas, desde la terminal del server. Solo quien corre Multti las
 * registra: son la cara de lo que se puede hacer, así que no las sube cualquiera.
 *
 *   npm run plantillas                                         → las lista
 *   npm run plantillas -- agregar <sala> <tipo> "Título" "Descripción" [--imagen captura.png]
 *   npm run plantillas -- quitar <sala>
 *
 * La miniatura la toma el server solo, la primera vez que alguien abre la lista
 * (hace falta la vista previa corriendo). `--imagen` es para cuando no hay vista
 * previa que capturar, como un reporte, o para poner una captura mejor.
 */

const USO =
  `uso:\n` +
  `  npm run plantillas\n` +
  `  npm run plantillas -- agregar <sala> <tipo> "Título" "Descripción" [--imagen captura.png]\n` +
  `  npm run plantillas -- quitar <sala>\n` +
  `tipos: ${TIPOS_DE_PLANTILLA.join(", ")}`;

function salir(msg: string, code = 1): never {
  console.error(msg);
  process.exit(code);
}

async function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf("--imagen");
  const imagen = i !== -1 ? args[i + 1] : undefined;
  if (i !== -1) args.splice(i, 2);
  const [accion, sala, tipo, titulo, descripcion] = args;
  const storage = await getStorage();

  if (accion === "agregar") {
    if (!sala || !tipo || !titulo) salir(USO);
    if (!(TIPOS_DE_PLANTILLA as readonly string[]).includes(tipo)) {
      salir(`el tipo "${tipo}" no existe. Tipos: ${TIPOS_DE_PLANTILLA.join(", ")}`);
    }
    if (!(await storage.getRoom(sala))) salir(`no encontré la sala ${sala}`);

    let miniatura: Uint8Array | null = null;
    if (imagen) {
      try {
        miniatura = await readFile(imagen);
      } catch {
        salir(`no pude leer la imagen ${imagen}`);
      }
    }
    await storage.agregarPlantilla({
      roomId: sala,
      tipo: tipo as TipoDePlantilla,
      titulo: titulo.trim().slice(0, 60),
      descripcion: (descripcion ?? "").trim().slice(0, 140),
      agregada: Date.now(),
      miniatura,
    });
    console.log(
      `listo: ${sala} es la plantilla "${titulo}" (${tipo})` +
        (miniatura ? " con tu imagen" : ". La captura se toma sola la primera vez que alguien abra las plantillas"),
    );
    process.exit(0);
  }

  if (accion === "quitar") {
    if (!sala) salir(USO);
    const ok = await storage.quitarPlantilla(sala);
    console.log(ok ? `${sala} ya no es plantilla (la sala sigue igual)` : `${sala} no era plantilla`);
    process.exit(ok ? 0 : 1);
  }

  if (accion) salir(USO);

  const lista = await storage.listarPlantillas();
  console.log(`Plantillas: ${lista.length}`);
  for (const p of lista) {
    const foto = p.conMiniatura ? "con foto" : "sin foto";
    console.log(`  ${p.roomId.padEnd(18)} ${p.tipo.padEnd(12)} ${p.titulo}  · ${foto}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
