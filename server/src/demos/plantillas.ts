import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Demo: las plantillas.
 * Uso: npm run demo:plantillas
 *
 * Lo que se protege:
 * - Que usar una plantilla dé una sala nueva con el proyecto, y sin los
 *   secretos ni el chat (lo mismo que un remix).
 * - Que la sala nueva NO quede ligada a la plantilla: sin eso tendría "Volver
 *   al original", y cualquier alumno llegaría a editar la plantilla de todos.
 * - Que solo quien corre Multti registra plantillas, con el comando.
 * - Que el remix normal no cambió.
 *
 * Sin Docker ni red: salas de verdad, con una base y workspaces temporales.
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
  console.log("=== Plantillas ===\n");
  const raiz = await mkdtemp(join(tmpdir(), "multi-plantillas-"));
  process.env.MULTI_DB = join(raiz, "multi.db");
  process.env.MULTI_SIN_AISLAMIENTO = "1";
  const { createRoom, createRemix } = await import("../rooms.js");
  const { commitAll } = await import("../engine/git.js");
  const { getStorage } = await import("../storage/index.js");
  const storage = await getStorage();
  const creadas: string[] = [];

  /** El comando, como lo correría Erick en el server. */
  const comando = (...args: string[]): { code: number; out: string } => {
    try {
      const out = execFileSync("npx", ["tsx", "--no-warnings", "src/plantillas.ts", ...args], {
        env: { ...process.env, MULTI_DB: process.env.MULTI_DB },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { code: 0, out };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  };

  try {
    // La plantilla: un proyecto con código, un secreto y un documento.
    const plantilla = await createRoom();
    creadas.push(plantilla.workspace.dir);
    const dir = plantilla.workspace.dir;
    await mkdir(join(dir, "src"), { recursive: true });
    await mkdir(join(dir, "documento"), { recursive: true });
    await writeFile(join(dir, "index.html"), "<h1>Inventario</h1>\n");
    await writeFile(join(dir, "src", "app.js"), "export const productos = 10;\n");
    await writeFile(join(dir, "documento", "doc.yjs"), "contenido del reporte");
    await writeFile(join(dir, ".env"), "SECRETO=no-se-copia\n");
    await commitAll(dir, { message: "la plantilla", author: "agente-1" });

    console.log("1. El comando registra, lista y quita");
    let r = comando("agregar", plantilla.id, "app", "Inventario de tiendita", "Agrega, edita y busca productos");
    check("agregar funciona", r.code === 0 && r.out.includes("listo"), r.out);
    const p = await storage.plantilla(plantilla.id);
    check("queda guardada con su tipo, título y descripción", p?.tipo === "app" && p.titulo === "Inventario de tiendita" && p.descripcion === "Agrega, edita y busca productos", JSON.stringify(p));
    check("sin foto todavía (la toma el server después)", p?.conMiniatura === false);
    r = comando();
    check("listar la enseña", r.code === 0 && r.out.includes(plantilla.id) && r.out.includes("Inventario de tiendita"), r.out);
    r = comando("agregar", plantilla.id, "inventado", "X");
    check("un tipo que no existe se rechaza", r.code !== 0 && r.out.includes("no existe"), r.out);
    r = comando("agregar", "sala-que-no-existe", "app", "X");
    check("una sala que no existe se rechaza", r.code !== 0 && r.out.includes("no encontré"), r.out);

    const img = join(raiz, "captura.jpg");
    await writeFile(img, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    r = comando("agregar", plantilla.id, "app", "Inventario de tiendita", "Agrega, edita y busca productos", "--imagen", img);
    check("con --imagen guarda la foto", r.code === 0 && (await storage.plantilla(plantilla.id))?.conMiniatura === true, r.out);
    r = comando("agregar", plantilla.id, "app", "Inventario v2", "Otra descripción");
    const p2 = await storage.plantilla(plantilla.id);
    check("volver a agregar cambia el texto y respeta la foto", p2?.titulo === "Inventario v2" && p2.conMiniatura === true, JSON.stringify(p2));

    console.log("\n2. Usar la plantilla da una sala nueva y limpia");
    const nueva = await createRemix(plantilla, { plantilla: "Inventario v2" });
    creadas.push(nueva.workspace.dir);
    const ndir = nueva.workspace.dir;
    check("es otra sala", nueva.id !== plantilla.id && ndir !== dir);
    check("trae el proyecto", (await readFile(join(ndir, "src", "app.js"), "utf8")) === "export const productos = 10;\n");
    check("y el documento (un reporte también sirve de plantilla)", existsSync(join(ndir, "documento", "doc.yjs")));
    check("sin el .env", !existsSync(join(ndir, ".env")));
    check("se llama como la plantilla", nueva.nombre === "Inventario v2", String(nueva.nombre));

    console.log("\n3. Sin liga a la plantilla");
    check("no sabe de dónde salió (no hay 'Volver al original')", nueva.origenId == null, String(nueva.origenId));
    const guardada = await storage.getRoom(nueva.id);
    check("ni en la base", guardada?.origenId == null, JSON.stringify(guardada));
    check("la plantilla no la cuenta como remix suyo", (await storage.remixesDe(plantilla.id)).length === 0);
    await writeFile(join(ndir, "src", "app.js"), "export const productos = 99;\n");
    await commitAll(ndir, { message: "cambio del alumno", author: "agente-1" });
    check("cambiarla no toca la plantilla", (await readFile(join(dir, "src", "app.js"), "utf8")) === "export const productos = 10;\n");

    console.log("\n4. Una sala normal no es plantilla");
    const normal = await createRoom();
    creadas.push(normal.workspace.dir);
    check("la ruta de usar la rechazaría", (await storage.plantilla(normal.id)) === null);

    console.log("\n5. El remix normal no cambió");
    const remix = await createRemix(plantilla);
    creadas.push(remix.workspace.dir);
    check("sigue ligado a su original", remix.origenId === plantilla.id);
    check("y con su nombre de siempre", remix.nombre === `${plantilla.id} (remix)`, String(remix.nombre));

    console.log("\n6. Quitar");
    r = comando("quitar", plantilla.id);
    check("quitar funciona", r.code === 0 && (await storage.plantilla(plantilla.id)) === null, r.out);
    check("y la sala sigue ahí", (await storage.getRoom(plantilla.id)) !== null);
    r = comando("quitar", plantilla.id);
    check("quitar una que no era avisa", r.code !== 0 && r.out.includes("no era plantilla"), r.out);

    console.log("\n7. El orden sigue al tipo");
    const a = await createRoom();
    const b = await createRoom();
    creadas.push(a.workspace.dir, b.workspace.dir);
    await storage.agregarPlantilla({ roomId: a.id, tipo: "juego", titulo: "Naves", descripcion: "", agregada: 1 });
    await storage.agregarPlantilla({ roomId: b.id, tipo: "presentacion", titulo: "Sistema solar", descripcion: "", agregada: 2 });
    const lista = await storage.listarPlantillas();
    check("la presentación va antes que el juego", lista.map((x) => x.tipo).join(",") === "presentacion,juego", JSON.stringify(lista));
  } finally {
    for (const d of creadas) await rm(d, { recursive: true, force: true });
    await rm(raiz, { recursive: true, force: true });
  }

  console.log(`\n${pass} pasaron, ${fail} fallaron`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("demo falló:", err);
  process.exit(1);
});
