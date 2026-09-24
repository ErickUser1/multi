import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqlTool } from "../agent/tools/sql.js";
import type { ToolContext } from "../agent/tools/base.js";
import { fileMutation } from "../engine/file-mutation.js";
import { AgentRegistry, resumenDeOtros } from "../engine/agents.js";
import { SqliteStorage } from "../storage/sqlite.js";
import { startTurn, listTurns } from "../engine/turns.js";

/**
 * Demo: lo que no puede pasar dos veces a la vez, no pasa.
 * Uso: npm run demo:candados
 *
 * 1. La tool sql corre de a uno por sala, y lo que hizo llega al resumen de los
 *    demás agentes, sin mezclar salas.
 * 2. La conexión de Supabase se actualiza por campos: renovar el token no borra
 *    el proyecto, y guardar el proyecto no regresa tokens viejos.
 *
 * No necesita red: el SQL "corre" contra una función que tarda y anota, y la
 * conexión se guarda en una base SQLite temporal.
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

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Un ejecutarSql que tarda y cuenta cuántos corren a la vez. */
function baseLenta() {
  const estado = { ahora: 0, maximo: 0, orden: [] as string[] };
  const ejecutar = async (sql: string) => {
    estado.ahora++;
    estado.maximo = Math.max(estado.maximo, estado.ahora);
    await dormir(150);
    estado.orden.push(sql);
    estado.ahora--;
  };
  return { estado, ejecutar };
}

async function main() {
  console.log("\n=== candados ===\n");
  const raiz = await mkdtemp(join(tmpdir(), "multi-candados-"));

  console.log("1. sql corre de a uno por sala");
  {
    const sala = join(raiz, "sala-a");
    const { estado, ejecutar } = baseLenta();
    const esperas: Array<{ path: string; holder?: string }> = [];
    const ctx = (agentId: string) =>
      ({
        workspaceDir: sala,
        agentId,
        ejecutarSql: ejecutar,
        onWaitStart: (i: { path: string; holder?: string }) => esperas.push(i),
        onWaitEnd: () => {},
      }) as unknown as ToolContext;

    await Promise.all([
      sqlTool.run({ sql: "create table tareas (id bigint)", descripcion: "crea-tabla-tareas" }, ctx("agente-1")),
      sqlTool.run({ sql: "alter table tareas add column hecha boolean", descripcion: "agrega-hecha" }, ctx("agente-2")),
    ]);
    check("nunca corrieron dos a la vez", estado.maximo === 1, `máximo ${estado.maximo}`);
    check("en el orden en que llegaron", estado.orden[0].startsWith("create table"), estado.orden.join(" | "));
    check(
      "el segundo supo a quién esperaba",
      esperas.length === 1 && esperas[0].holder === "agente-1" && esperas[0].path === "migraciones",
      JSON.stringify(esperas),
    );
    const archivos = (await readdir(join(sala, "migraciones"))).sort();
    check("dos migraciones, sin pisarse aunque caigan en el mismo segundo", archivos.length === 2, archivos.join(", "));
  }

  console.log("\n2. Dos salas no se esperan entre sí");
  {
    const { estado, ejecutar } = baseLenta();
    const ctx = (sala: string) =>
      ({ workspaceDir: join(raiz, sala), agentId: "agente-1", ejecutarSql: ejecutar }) as unknown as ToolContext;
    await Promise.all([
      sqlTool.run({ sql: "create table a (id bigint)", descripcion: "a" }, ctx("sala-b")),
      sqlTool.run({ sql: "create table b (id bigint)", descripcion: "b" }, ctx("sala-c")),
    ]);
    check("corrieron al mismo tiempo", estado.maximo === 2, `máximo ${estado.maximo}`);
  }

  console.log("\n3. Los demás se enteran, y solo los de la misma sala");
  {
    const deA = fileMutation.trabajoRecienteDeOtros("agente-9", { sala: join(raiz, "sala-a") });
    check(
      "en la sala A se ven sus dos migraciones",
      deA.filter((f) => f.path.startsWith("migraciones/")).length === 2,
      JSON.stringify(deA.map((f) => f.path)),
    );
    check("y no las de las salas B y C, aunque sean de un agente-1", deA.every((f) => !f.path.includes("-a.sql") && !f.path.includes("-b.sql")));
    check("con rutas relativas a la sala", deA.every((f) => !f.path.startsWith("/")), deA[0]?.path);

    const reg = new AgentRegistry();
    const a1 = reg.spawn("haz las tareas")!;
    const a2 = reg.spawn("agrega un filtro")!;
    reg.finish(a1.id);
    const resumen = resumenDeOtros(reg, a2.id, fileMutation.trabajoRecienteDeOtros(a2.id, { sala: join(raiz, "sala-a") })) ?? "";
    check("el resumen dice qué cambió en la base", resumen.includes("cambió la base: crea-tabla-tareas"), resumen);
    check("sin listar la migración como archivo por releer", !resumen.includes("ya tocó: migraciones"), resumen);
    check("y le dice que revise con ver_base", resumen.includes("ver_base"));
  }

  console.log("\n4. La conexión de Supabase se actualiza por campos");
  {
    process.env.MULTI_LLAVE ??= "llave-de-la-demo";
    const storage = new SqliteStorage(join(raiz, "multi.db"));
    await storage.init();
    await storage.createRoom({ id: "sala-sb", workspaceDir: join(raiz, "sala-sb"), createdAt: Date.now(), lastActiveAt: Date.now() });
    await storage.guardarConexionSupabase({
      roomId: "sala-sb",
      acceso: "acceso-1",
      refresco: "refresco-1",
      expiraEn: 1,
      conectadoEn: Date.now(),
    });

    // La preparación guarda el proyecto; en medio, alguien renovó el token.
    await storage.actualizarConexionSupabase("sala-sb", { acceso: "acceso-2", refresco: "refresco-2", expiraEn: 2 });
    await storage.actualizarConexionSupabase("sala-sb", { proyecto: "refdelproyecto", password: "secreta" });
    let c = await storage.conexionSupabase("sala-sb");
    check("guardar el proyecto no regresa los tokens viejos", c?.acceso === "acceso-2" && c?.refresco === "refresco-2", JSON.stringify(c));
    check("y el proyecto quedó", c?.proyecto === "refdelproyecto" && c?.password === "secreta");

    // Otra renovación después: no toca el proyecto.
    await storage.actualizarConexionSupabase("sala-sb", { acceso: "acceso-3", refresco: "refresco-3", expiraEn: 3 });
    c = await storage.conexionSupabase("sala-sb");
    check("renovar el token no borra el proyecto ni la contraseña", c?.proyecto === "refdelproyecto" && c?.password === "secreta", JSON.stringify(c));
    check("y los tokens son los nuevos", c?.acceso === "acceso-3" && c?.expiraEn === 3);

    await storage.actualizarConexionSupabase("sin-conexion", { acceso: "x" });
    check("actualizar una sala sin conexión no crea nada", (await storage.conexionSupabase("sin-conexion")) === null);
  }

  console.log("\n5. Dos turnos que empiezan a la vez no tumban el server");
  {
    // Antes compartían el nombre temporal: el segundo rename tronaba con ENOENT
    // sin que nadie lo atrapara, y se caía el server con todas las salas. Y el
    // que sí escribía borraba el turno del otro.
    const sala = join(raiz, "sala-turnos");
    let error = "";
    try {
      await Promise.all(
        Array.from({ length: 5 }, (_, i) => startTurn(sala, { roomId: "sala-turnos", agentId: `agente-${i + 1}`, task: `tarea ${i}` })),
      );
    } catch (err) {
      error = String(err);
    }
    check("cinco a la vez, sin error", error === "", error);
    const turnos = await listTurns(sala);
    check("y quedan los cinco", turnos.length === 5, `quedaron ${turnos.length}`);
  }

  await rm(raiz, { recursive: true, force: true });
  console.log(`\n${pass} pasaron, ${fail} fallaron\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\ndemo falló:", err);
  process.exit(1);
});
