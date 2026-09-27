import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTool, writeTool, editTool } from "../agent/tools/fs.js";
import type { ToolContext } from "../agent/tools/base.js";
import { localRunner } from "../engine/runner.js";
import { fileMutation } from "../engine/file-mutation.js";
import { AgentRegistry, resumenDeOtros } from "../engine/agents.js";
import { startTurn, commitTurn, trabajoDeOtrosDesde } from "../engine/turns.js";

/**
 * Demo: un agente no borra el trabajo de otro sin enterarse.
 * Uso: npm run demo:respetar
 *
 * Reproduce lo que pasó en una sala real (app de hábitos, 26/9):
 *   1. agente-1 hace la app base.
 *   2. agente-2 le agrega niveles y gráficas, y los conecta en App.tsx.
 *   3. Minutos después piden a agente-1 un cambio grande. No recibió nada de
 *      agente-2 (el resumen cubría dos minutos), reescribió App.tsx sin leerlo
 *      y luego borró lo de agente-2 porque "no estaba conectado".
 *
 * Sin red ni API key: las tools corren contra un repo git temporal.
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

const PEDIDO_2 =
  "tu haz la app bonita, que se vea como juego para que me den ganas de seguir, con puntos o niveles o algo asi, y que tenga graficas para ver como voy cada semana.";

async function nuevaSala(raiz: string, nombre: string): Promise<string> {
  const dir = join(raiz, nombre);
  execFileSync("mkdir", ["-p", dir]);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

function ctxDe(dir: string, agentId: string): ToolContext {
  return { workspaceDir: dir, runner: localRunner(dir), agentId };
}

/** Corre una tool y devuelve el texto o el error, sin tronar. */
async function correr(
  tool: typeof writeTool,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ ok: boolean; texto: string }> {
  try {
    return { ok: true, texto: String(await tool.run(input, ctx)) };
  } catch (err) {
    return { ok: false, texto: (err as Error).message };
  }
}

/** Un turno completo: lo abre, corre `fn` y lo cierra con commit. */
async function turno(dir: string, agentId: string, task: string, fn: () => Promise<void>) {
  const t = await startTurn(dir, { roomId: "demo", agentId, task });
  await fn();
  await commitTurn(dir, t, { summary: task });
}

async function main() {
  console.log("\n=== respetar el trabajo de otros agentes ===\n");
  const raiz = await mkdtemp(join(tmpdir(), "multi-respetar-"));
  const sala = await nuevaSala(raiz, "lofi");
  const reg = new AgentRegistry();
  const a1 = reg.spawn("app de hábitos")!;
  const a2 = reg.spawn(PEDIDO_2)!;

  // 1. agente-1 hace la base.
  await turno(sala, a1.id, "quiero una app para mis habitos, tu encargate de la base de datos", async () => {
    const c = ctxDe(sala, a1.id);
    await writeTool.run({ path: "src/App.tsx", content: "export default function App() {\n  return <Habitos />\n}\n" }, c);
    await writeTool.run({ path: "src/lib/habits.ts", content: "export const habitos = []\n" }, c);
  });
  reg.finish(a1.id);

  // 2. agente-2 agrega la gamificación y la conecta en App.tsx.
  await turno(sala, a2.id, PEDIDO_2, async () => {
    const c = ctxDe(sala, a2.id);
    await readTool.run({ path: "src/App.tsx" }, c);
    await editTool.run(
      { path: "src/App.tsx", old_string: "  return <Habitos />", new_string: "  return <><LevelBadge /><Habitos /></>" },
      c,
    );
    await writeTool.run({ path: "src/lib/gamification.ts", content: "export const nivel = 1\n" }, c);
    await writeTool.run({ path: "src/components/LevelBadge.tsx", content: "export function LevelBadge() {}\n" }, c);
  });
  reg.finish(a2.id);

  console.log("1. Minutos después: agente-1 vuelve para un cambio grande");
  {
    await startTurn(sala, { roomId: "demo", agentId: a1.id, task: "hoja por dia" });
    // Pasaron más de dos minutos: el registro en vivo ya no trae nada.
    const enVivo = fileMutation.trabajoRecienteDeOtros(a1.id, { sala, dentroDeMs: 0 });
    const antes = resumenDeOtros(reg, a1.id, enVivo);
    check("como antes (solo en vivo): no le llegaba nada — el bug", antes === null, String(antes));

    const desde = await trabajoDeOtrosDesde(sala, a1.id);
    const r = resumenDeOtros(reg, a1.id, enVivo, new Map([[a2.id, "Le agregué niveles y gráficas"]]), desde) ?? "";
    check("ahora sí le llega lo de agente-2", r.includes("agente-2"), r);
    check("con el pedido COMPLETO, no cortado", r.includes("y que tenga graficas para ver como voy cada semana"), r);
    check("y los archivos que dejó", r.includes("src/lib/gamification.ts") && r.includes("src/components/LevelBadge.tsx"), r);
    check("y lo que contó al terminar", r.includes("Le agregué niveles y gráficas"), r);
    check("y que hay que adaptarlo, no quitarlo", r.includes("ADÁPTALO"), r);
    check("dice 'desde tu último turno'", r.includes("Desde tu último turno"), r);
    check("no le cuenta su propio turno", !r.includes("encargate de la base"), r);
  }

  console.log("\n2. Reescribir App.tsx sin leerlo: no pasa");
  {
    const c = ctxDe(sala, a1.id);
    const nuevo = "export default function App() {\n  return <HojaDelDia />\n}\n";
    const r = await correr(writeTool, { path: "src/App.tsx", content: nuevo }, c);
    check("la escritura falla", !r.ok, r.texto);
    check("y dice de quién es el trabajo", r.texto.includes("agente-2"), r.texto);
    check("y qué hacer: leerlo y adaptarlo", r.texto.includes("read_file") && r.texto.includes("adáptalo"), r.texto);
    const enDisco = await readFile(join(sala, "src/App.tsx"), "utf8");
    check("App.tsx sigue con lo de agente-2", enDisco.includes("LevelBadge"), enDisco);

    await readTool.run({ path: "src/App.tsx" }, c);
    const adaptado = "export default function App() {\n  return <><LevelBadge /><HojaDelDia /></>\n}\n";
    const r2 = await correr(writeTool, { path: "src/App.tsx", content: adaptado }, c);
    check("después de leerlo, la misma escritura pasa", r2.ok, r2.texto);
    const r3 = await correr(writeTool, { path: "src/App.tsx", content: adaptado + "// otra vuelta\n" }, c);
    check("y puede volver a escribirlo sin releer lo que él mismo dejó", r3.ok, r3.texto);
  }

  console.log("\n3. Lo que no cambia");
  {
    const c = ctxDe(sala, a1.id);
    const propio = await correr(writeTool, { path: "src/lib/habits.ts", content: "export const dias = []\n" }, c);
    check("un archivo solo suyo se reescribe sin leer", propio.ok, propio.texto);
    const nuevo = await correr(writeTool, { path: "src/lib/days.ts", content: "export {}\n" }, c);
    check("un archivo nuevo se crea sin leer nada", nuevo.ok, nuevo.texto);
    const edit = await correr(
      editTool,
      { path: "src/lib/gamification.ts", old_string: "nivel = 1", new_string: "nivel = 2" },
      c,
    );
    check("edit_file sobre lo de otro sigue pasando", edit.ok, edit.texto);
  }

  console.log("\n4. Editar un pedazo no cuenta como haberlo visto entero");
  {
    // agente-1 ya editó gamification.ts (último escritor: él), pero nunca lo
    // leyó completo, y en el historial el archivo es de agente-2.
    const c = ctxDe(sala, a1.id);
    const r = await correr(writeTool, { path: "src/lib/gamification.ts", content: "export {}\n" }, c);
    check("reescribirlo entero sigue pidiendo leerlo", !r.ok && r.texto.includes("agente-2"), r.texto);
    await readTool.run({ path: "src/lib/gamification.ts" }, c);
    await editTool.run({ path: "src/lib/gamification.ts", old_string: "nivel = 2", new_string: "nivel = 3" }, c);
    const r2 = await correr(writeTool, { path: "src/lib/gamification.ts", content: "export const nivel = 4\n" }, c);
    check("si lo leyó y luego editó, ya conoce el resultado y pasa", r2.ok, r2.texto);
  }

  console.log("\n5. Si otro lo cambia DESPUÉS de que lo leyó, hay que volver a leerlo");
  {
    const c1 = ctxDe(sala, a1.id);
    const c2 = ctxDe(sala, a2.id);
    await readTool.run({ path: "src/components/LevelBadge.tsx" }, c1);
    await readTool.run({ path: "src/components/LevelBadge.tsx" }, c2);
    await writeTool.run({ path: "src/components/LevelBadge.tsx", content: "export function LevelBadge() { return 1 }\n" }, c2);
    const r = await correr(writeTool, { path: "src/components/LevelBadge.tsx", content: "x\n" }, c1);
    check("la lectura vieja ya no vale", !r.ok, r.texto);
  }

  console.log("\n6. Un agente que llega nuevo recibe lo que otros ya hicieron");
  {
    const a3 = reg.spawn("agrega modo oscuro")!;
    const desde = await trabajoDeOtrosDesde(sala, a3.id);
    const r = resumenDeOtros(reg, a3.id, [], undefined, desde) ?? "";
    check("dice 'antes de que llegaras'", r.includes("Antes de que llegaras"), r);
    check("con los dos agentes", r.includes("agente-1") && r.includes("agente-2"), r);
    reg.finish(a3.id);
  }

  console.log("\n7. Nada nuevo desde su último turno: no se le cuenta nada");
  {
    const s = await nuevaSala(raiz, "quieta");
    await turno(s, "agente-1", "uno", async () => {
      await writeTool.run({ path: "a.txt", content: "a\n" }, ctxDe(s, "agente-1"));
    });
    await turno(s, "agente-2", "dos", async () => {
      await writeTool.run({ path: "b.txt", content: "b\n" }, ctxDe(s, "agente-2"));
    });
    const d = await trabajoDeOtrosDesde(s, "agente-2");
    check("agente-2 no recibe el turno de agente-1, que fue antes del suyo", d.turnos.length === 0, JSON.stringify(d));
  }

  console.log("\n8. El agente que trabaja solo no nota nada");
  {
    const s = await nuevaSala(raiz, "solo");
    const c = ctxDe(s, "agente-1");
    await turno(s, "agente-1", "uno", async () => {
      await writeTool.run({ path: "App.tsx", content: "1\n" }, c);
    });
    await turno(s, "agente-1", "dos", async () => {
      const r = await correr(writeTool, { path: "App.tsx", content: "2\n" }, c);
      check("reescribe su archivo sin leerlo", r.ok, r.texto);
    });
    const d = await trabajoDeOtrosDesde(s, "agente-1");
    const reg1 = new AgentRegistry();
    reg1.spawn("dos");
    check("y no recibe resumen", resumenDeOtros(reg1, "agente-1", [], undefined, d) === null);
  }

  console.log("\n9. Dos salas con los mismos nombres de agente no se mezclan");
  {
    const otra = await nuevaSala(raiz, "otra");
    await writeFile(join(otra, "App.tsx"), "de otra sala\n");
    const r = await correr(writeTool, { path: "App.tsx", content: "mío\n" }, ctxDe(otra, "agente-1"));
    check("lo de agente-2 en la sala A no bloquea a agente-1 en la sala B", r.ok, r.texto);
    const d = await trabajoDeOtrosDesde(otra, "agente-1");
    check("ni le llega en el resumen", d.turnos.length === 0);
  }

  console.log("\n10. Fallas del disco no rompen el turno");
  {
    const s = await nuevaSala(raiz, "rota");
    await writeFile(`${s}.turns.json`, "{ esto no es json");
    const d = await trabajoDeOtrosDesde(s, "agente-1");
    check("turns.json dañado: sin historial, sin tronar", d.turnos.length === 0);
    const sinRepo = join(raiz, "sin-repo");
    execFileSync("mkdir", ["-p", sinRepo]);
    await writeFile(join(sinRepo, "x.txt"), "x\n");
    const r = await correr(writeTool, { path: "x.txt", content: "y\n" }, ctxDe(sinRepo, "agente-9"));
    check("carpeta sin git: la escritura pasa como antes", r.ok, r.texto);
  }

  console.log("\n11. Muchos turnos: solo los últimos, y dice cuántos faltan");
  {
    const s = await nuevaSala(raiz, "larga");
    await turno(s, "agente-1", "base", async () => {
      await writeTool.run({ path: "a.txt", content: "0\n" }, ctxDe(s, "agente-1"));
    });
    for (let i = 1; i <= 7; i++) {
      await turno(s, "agente-2", `cambio ${i}`, async () => {
        await writeTool.run({ path: `f${i}.txt`, content: `${i}\n` }, ctxDe(s, "agente-2"));
      });
    }
    const d = await trabajoDeOtrosDesde(s, "agente-1");
    check("manda 5", d.turnos.length === 5, String(d.turnos.length));
    check("los más recientes", d.turnos.at(-1)?.task === "cambio 7" && d.turnos[0].task === "cambio 3");
    const reg2 = new AgentRegistry();
    reg2.spawn("x");
    const r = resumenDeOtros(reg2, "agente-1", [], undefined, d) ?? "";
    check("y avisa de los 2 que quedaron fuera", r.includes("2 turnos más") && r.includes("git log"), r);
  }

  console.log("\n12. El que acaba de terminar no sale dos veces");
  {
    const enVivo = fileMutation.trabajoRecienteDeOtros(a1.id, { sala });
    const desde = await trabajoDeOtrosDesde(sala, a1.id);
    const r = resumenDeOtros(reg, a1.id, enVivo, undefined, desde) ?? "";
    const veces = r.split("\n").filter((l) => l.startsWith("agente-2")).length;
    check("agente-2 aparece una vez", veces === 1, r);
  }

  await rm(raiz, { recursive: true, force: true });
  console.log(`\n${pass} pasaron, ${fail} fallaron`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
