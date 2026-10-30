import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStorage } from "../storage/sqlite.js";

/**
 * Demo: compartir con la comunidad y Explorar.
 * Uso: npm run demo:comunidad
 *
 * Lo que importa de la comunidad es que nadie salga ahí sin querer, y que lo que
 * sale se pueda jugar y moderar:
 *   - sin publicar no se comparte (el "Jugar" de la tarjeta no tendría a dónde ir);
 *   - compartir y quitar, y que Explorar solo traiga lo compartido;
 *   - ocultar desde el server baja la tarjeta y volver a compartir no la destapa;
 *   - borrar la sala la quita de Explorar.
 *
 * Con el server de verdad (agente simulado, sin contenedor) y una base temporal.
 * No necesita red.
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

const PORT = 4300 + Math.floor(Math.random() * 500);
const BASE = `http://localhost:${PORT}`;

async function esperarServer(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {
      // todavía no
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("el server no arrancó");
}

async function main() {
  console.log("=== Comunidad y Explorar ===\n");
  const raiz = await mkdtemp(join(tmpdir(), "multi-comunidad-"));
  const db = join(raiz, "multi.db");

  // Las salas se siembran antes de arrancar: el server las despierta de la base
  // con su URL publicada, igual que una sala real que publicó ayer.
  const sembrar = new SqliteStorage(db);
  await sembrar.init();
  const sala = (id: string) => ({ id, workspaceDir: join(raiz, id), createdAt: Date.now(), lastActiveAt: Date.now() });
  await sembrar.createRoom(sala("box-publicado-1"));
  await sembrar.setPublicacion("box-publicado-1", "https://box.vercel.app", "box");
  await sembrar.createRoom(sala("tacos-publicado-2"));
  await sembrar.setPublicacion("tacos-publicado-2", "https://tacos.pages.dev", "tacos");
  await sembrar.createRoom(sala("sin-publicar-3"));

  let server: ChildProcess | null = null;
  try {
    server = spawn("npx", ["tsx", "src/index.ts"], {
      env: { ...process.env, PORT: String(PORT), MULTI_DB: db, MULTI_TEST_MOCK: "1", MULTI_SIN_AISLAMIENTO: "1" },
      stdio: "ignore",
    });
    await esperarServer();
    const compartir = (id: string, body: object) =>
      fetch(`${BASE}/rooms/${id}/comunidad`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const explorar = async (q = "?categoria=juego") =>
      ((await (await fetch(`${BASE}/comunidad${q}`)).json()) as { proyectos: { id: string; titulo: string; autor: string; url: string }[] }).proyectos;

    console.log("1. Explorar arranca vacío");
    check("sin nada compartido, lista vacía", (await explorar()).length === 0);

    console.log("\n2. Sin publicar no se comparte");
    const sinPublicar = await compartir("sin-publicar-3", { categoria: "juego", autor: "Ana" });
    check("lo rechaza", sinPublicar.status === 409, String(sinPublicar.status));
    check("y dice por qué", ((await sinPublicar.json()) as { error: string }).error.includes("publicar"));

    console.log("\n3. Compartir");
    const r = await compartir("box-publicado-1", { categoria: "juego", autor: "  Erick   B ", titulo: "Box de la UAQ" });
    const d = (await r.json()) as { comunidad?: { titulo: string; autor: string; oculta: boolean } };
    check("sale bien", r.ok, String(r.status));
    check("con su título y autor limpio", d.comunidad?.titulo === "Box de la UAQ" && d.comunidad?.autor === "Erick B", JSON.stringify(d));
    const lista = await explorar();
    check("aparece en Explorar", lista.length === 1 && lista[0]?.id === "box-publicado-1", JSON.stringify(lista));
    check("con el link para jugarlo", lista[0]?.url === "https://box.vercel.app");
    check("una categoría que no existe se rechaza", (await compartir("tacos-publicado-2", { categoria: "porno" })).status === 400);
    check("y no se coló", (await explorar()).length === 1);

    console.log("\n4. Lo más nuevo primero, y sin título usa el nombre publicado");
    await compartir("tacos-publicado-2", { categoria: "juego", autor: "" });
    const dos = await explorar();
    check("dos en Explorar, el último arriba", dos.length === 2 && dos[0]?.id === "tacos-publicado-2", JSON.stringify(dos.map((p) => p.id)));
    check("título por default: el nombre con que se publicó", dos[0]?.titulo === "tacos", dos[0]?.titulo);
    check("autor vacío sale como anónimo", dos[0]?.autor === "anónimo", dos[0]?.autor);
    check("sin categoría en la consulta, también salen", (await explorar("")).length === 2);

    console.log("\n5. La sala sabe si está compartida");
    const otra = new SqliteStorage(db);
    await otra.init();
    check("enComunidad la encuentra", (await otra.enComunidad("box-publicado-1"))?.titulo === "Box de la UAQ");
    check("y la que no, no", (await otra.enComunidad("sin-publicar-3")) === null);

    console.log("\n6. Moderar: ocultar la baja, y volver a compartir no la destapa");
    check("ocultar", await otra.ocultarEnComunidad("tacos-publicado-2", true));
    check("ya no sale en Explorar", !(await explorar()).some((p) => p.id === "tacos-publicado-2"));
    await compartir("tacos-publicado-2", { categoria: "juego", autor: "otra vez" });
    check("volver a compartir no la destapa", !(await explorar()).some((p) => p.id === "tacos-publicado-2"));
    check("pero la sala sabe que está oculta", (await otra.enComunidad("tacos-publicado-2"))?.oculta === true);
    check("ocultar algo no compartido dice que no", !(await otra.ocultarEnComunidad("sin-publicar-3", true)));
    await otra.ocultarEnComunidad("tacos-publicado-2", false);
    check("mostrar la regresa", (await explorar()).some((p) => p.id === "tacos-publicado-2"));

    console.log("\n7. Quitar");
    const quitar = await fetch(`${BASE}/rooms/box-publicado-1/comunidad`, { method: "DELETE" });
    check("sale bien", quitar.ok, String(quitar.status));
    check("ya no está en Explorar", !(await explorar()).some((p) => p.id === "box-publicado-1"));

    console.log("\n8. Borrar la sala la quita de Explorar");
    const borrar = await fetch(`${BASE}/rooms/tacos-publicado-2`, { method: "DELETE" });
    check("se borró", borrar.ok, String(borrar.status));
    check("Explorar quedó vacío", (await explorar()).length === 0);
    check("y no quedó la fila", (await otra.enComunidad("tacos-publicado-2")) === null);

    console.log("\n9. Miniaturas");
    check("sin miniatura, 404 (la tarjeta va con la inicial)", (await fetch(`${BASE}/comunidad/box-publicado-1/miniatura`)).status === 404);
    await otra.compartirEnComunidad({
      roomId: "box-publicado-1",
      categoria: "juego",
      titulo: "Box",
      autor: "Erick",
      miniatura: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      compartido: Date.now(),
    });
    const img = await fetch(`${BASE}/comunidad/box-publicado-1/miniatura`);
    check("con miniatura, la sirve como imagen", img.ok && img.headers.get("content-type") === "image/jpeg", img.headers.get("content-type") ?? "");
    const conFoto = (await (await fetch(`${BASE}/comunidad`)).json()) as { proyectos: { miniatura: string | null }[] };
    check("y la lista trae su ruta", conFoto.proyectos[0]?.miniatura?.startsWith("/comunidad/box-publicado-1/miniatura") === true);
  } finally {
    server?.kill("SIGTERM");
    await rm(raiz, { recursive: true, force: true });
  }

  console.log(`\n${pass} pasaron, ${fail} fallaron`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("demo falló:", err);
  process.exit(1);
});
