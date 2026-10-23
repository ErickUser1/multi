import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Demo: el remix de una sala.
 * Uso: npm run demo:remix
 *
 * Un remix es una sala nueva con una copia del proyecto, ligada al original.
 * Lo que se revisa es lo que importa de una copia: que traiga el código, que NO
 * traiga los secretos (cualquiera con el link puede hacer un remix), que quede
 * ligada para "Volver al original", y que cambiarla no toque el original.
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
  console.log("=== Remix de una sala ===\n");
  const raiz = await mkdtemp(join(tmpdir(), "multi-remix-"));
  // Antes de importar: la base se abre con lo que diga MULTI_DB, y sin
  // contenedor, para que la sala no intente levantar uno.
  process.env.MULTI_DB = join(raiz, "multi.db");
  process.env.MULTI_SIN_AISLAMIENTO = "1";
  const { createRoom, createRemix, NadaQueRemixear } = await import("../rooms.js");
  const { commitAll } = await import("../engine/git.js");
  const { getStorage } = await import("../storage/index.js");
  const storage = await getStorage();
  const creadas: string[] = [];

  try {
    console.log("1. El remix trae el código guardado");
    const original = await createRoom();
    creadas.push(original.workspace.dir);
    const dir = original.workspace.dir;
    await mkdir(join(dir, "src"), { recursive: true });
    await mkdir(join(dir, "node_modules", "algo"), { recursive: true });
    await writeFile(join(dir, "index.html"), "<h1>Box</h1>\n");
    await writeFile(join(dir, "src", "juego.js"), "export const golpe = 10;\n");
    await writeFile(join(dir, ".env"), "SECRETO=no-se-copia\n");
    await writeFile(join(dir, "node_modules", "algo", "index.js"), "// pesado\n");
    await writeFile(join(dir, "datos.db"), "binario de prueba");
    await commitAll(dir, { message: "el juego", author: "agente-1" });
    // Algo escrito después del último guardado no entra: el remix es de lo guardado.
    await writeFile(join(dir, "sin-guardar.txt"), "a medias\n");

    const remix = await createRemix(original);
    creadas.push(remix.workspace.dir);
    const rdir = remix.workspace.dir;
    check("es otra sala, con otro workspace", remix.id !== original.id && rdir !== dir);
    check("trae los archivos del proyecto", existsSync(join(rdir, "index.html")) && existsSync(join(rdir, "src", "juego.js")));
    check("con el mismo contenido", (await readFile(join(rdir, "src", "juego.js"), "utf8")) === "export const golpe = 10;\n");

    console.log("\n2. Lo que no se copia");
    check("no trae el .env (los secretos no se regalan)", !existsSync(join(rdir, ".env")));
    check("ni node_modules", !existsSync(join(rdir, "node_modules")));
    check("ni la base del proyecto", !existsSync(join(rdir, "datos.db")));
    check("ni lo que no estaba guardado", !existsSync(join(rdir, "sin-guardar.txt")));

    console.log("\n3. Queda ligado a su original");
    check("sabe de qué es remix", remix.origenId === original.id);
    check("y se llama como el original con (remix)", remix.nombre === `${original.id} (remix)`, String(remix.nombre));
    const guardada = await storage.getRoom(remix.id);
    check("el vínculo se guarda en la base", guardada?.origenId === original.id, JSON.stringify(guardada));
    check("y el nombre también", guardada?.nombre === `${original.id} (remix)`);
    const otro = await createRemix(original);
    creadas.push(otro.workspace.dir);
    check("el segundo se numera para distinguirlo", otro.nombre === `${original.id} (remix 2)`, String(otro.nombre));
    const lista = await storage.remixesDe(original.id);
    check("el original lista sus remixes", lista.length === 2 && lista.some((r) => r.id === remix.id) && lista.some((r) => r.id === otro.id), JSON.stringify(lista));
    check("una sala normal no es remix de nada", (await storage.getRoom(original.id))?.origenId == null);

    console.log("\n4. Cambiar el remix no toca el original");
    await writeFile(join(rdir, "src", "juego.js"), "export const golpe = 99;\n");
    await commitAll(rdir, { message: "más fuerte", author: "agente-1" });
    check("el original sigue igual", (await readFile(join(dir, "src", "juego.js"), "utf8")) === "export const golpe = 10;\n");
    const { stdout } = await import("node:child_process").then(({ execFileSync }) => ({
      stdout: execFileSync("git", ["log", "--format=%s"], { cwd: rdir, encoding: "utf8" }),
    }));
    check("el remix tiene su propio historial", stdout.trim().split("\n").join("|") === `más fuerte|Remix de ${original.id}`, stdout);

    console.log("\n5. Una sala sin nada guardado no se puede remixear");
    const vacia = await createRoom();
    creadas.push(vacia.workspace.dir);
    let error = "";
    try {
      await createRemix(vacia);
    } catch (err) {
      error = err instanceof NadaQueRemixear ? err.message : `otro error: ${String(err)}`;
    }
    check("lo dice claro", error.includes("no tiene nada guardado"), error);
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
