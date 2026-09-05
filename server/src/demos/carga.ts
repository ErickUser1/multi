import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createWorkspace } from "../engine/workspace.js";
import {
  isDockerAvailable,
  ensureImage,
  startContainer,
  stopContainer,
  execInContainer,
} from "../engine/container.js";
import { detectLaunch, startPreview, type Preview } from "../engine/preview.js";

const execFileP = promisify(execFile);

/**
 * Cuántas salas aguanta la máquina a la vez.
 * Uso: npm run demo:carga -- 20
 *
 * Nació de una fecha: el experimento del capítulo corre con ~20 alumnos y, en la
 * condición individual, cada uno necesita su propia sala. Multi nunca ha corrido
 * con más de tres activas, y lo único medido hasta hoy fue el estado de REPOSO
 * (124 MB y ~5% de CPU por sala), que no dice nada del pico: veinte contenedores
 * arrancando y veinte `npm install` a la vez.
 *
 * Por qué NO usa el agente simulado, que sería lo natural: su único escenario
 * escribe `src/App.jsx` y nada más. Sin `package.json`, `detectLaunch` devuelve
 * null y `arrancarPreview` se sale antes de pedir el contenedor — no habría ni
 * Docker ni dev servers, que es justo lo que se quiere medir. Así que aquí el
 * proyecto se SIEMBRA y se llama al motor directo, sin sockets ni modelo, igual
 * que hace demo:aislamiento.
 *
 * Lo que esta prueba NO cubre, y hay que tener presente al leer el resultado:
 * el costo real de la API, la red del aula, y que veinte personas hacen cosas
 * que un script no hace.
 */

const N = Number(process.argv[2] ?? 5);
const PREFIJO = "_carga-";

/** Puerto interno del dev server dentro del contenedor. Igual que en producción. */
const PUERTO_INTERNO = 5173;

interface Resultado {
  sala: string;
  ok: boolean;
  etapa: string;
  ms: number;
  error?: string;
}

/** Muestra de recursos de la máquina en un instante. */
interface Muestra {
  t: number;
  load1: number;
  memMB: number;
  contenedores: number;
}

const muestras: Muestra[] = [];
let midiendo = true;

/**
 * El proyecto que se siembra: un Vite mínimo de verdad.
 *
 * Con `--host` en el script a propósito: sin él Vite escucha solo en localhost,
 * que DENTRO del contenedor es el contenedor mismo, y el puerto publicado no
 * lleva a ningún lado. Es el mismo detalle que distingue las salas que levantan
 * de las que se quedan en el spinner.
 */
async function sembrarProyecto(dir: string): Promise<void> {
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: "carga",
        private: true,
        type: "module",
        scripts: { dev: "vite --host --port ${PORT:-5173}" },
        devDependencies: { vite: "^7.0.0" },
      },
      null,
      2,
    ),
    "utf8",
  );

  await writeFile(
    join(dir, "index.html"),
    `<!doctype html><html><head><meta charset="utf-8"><title>carga</title></head>` +
      `<body><h1>sala de carga</h1><script type="module" src="/src/main.js"></script></body></html>`,
    "utf8",
  );

  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "main.js"), `console.log("viva");\n`, "utf8");
}

/** Una sala completa: workspace, contenedor, dependencias y dev server. */
async function levantarSala(i: number): Promise<Resultado> {
  const sala = `${PREFIJO}${String(i).padStart(2, "0")}`;
  const t0 = Date.now();
  let etapa = "workspace";

  try {
    const ws = await createWorkspace(sala, { clean: true });
    await sembrarProyecto(ws.dir);

    etapa = "contenedor";
    const contenedor = await startContainer(sala, ws.dir, PUERTO_INTERNO);
    if (contenedor.publishedPort === null) {
      throw new Error("Docker no publicó puerto");
    }

    etapa = "dependencias";
    const inst = await execInContainer(sala, "npm install --no-audit --no-fund", {
      timeoutMs: 300_000,
      maxOutput: 2000,
    });
    if (inst.code !== 0) throw new Error(`npm install salió ${inst.code}`);

    etapa = "dev server";
    const launch = await detectLaunch(ws.dir);
    if (!launch) throw new Error("detectLaunch no encontró cómo arrancar");

    const preview: Preview = await startPreview(ws, launch, {
      roomId: sala,
      internalPort: PUERTO_INTERNO,
      publishedPort: contenedor.publishedPort,
    });
    previews.push(preview);

    return { sala, ok: true, etapa: "listo", ms: Date.now() - t0 };
  } catch (err) {
    return {
      sala,
      ok: false,
      etapa,
      ms: Date.now() - t0,
      error: err instanceof Error ? err.message.split("\n")[0] : String(err),
    };
  }
}

const previews: Preview[] = [];

/**
 * Muestrea la máquina mientras corre la prueba.
 *
 * El load average sobre el número de núcleos es lo que dice si hay saturación:
 * en 2 vCPU, un load sostenido arriba de 2.0 significa que hay trabajo esperando
 * turno. La memoria sale de `docker stats`, sumada entre contenedores.
 */
async function muestrear(): Promise<void> {
  while (midiendo) {
    try {
      const { stdout: up } = await execFileP("cat", ["/proc/loadavg"], { timeout: 5000 });
      const load1 = Number(up.trim().split(/\s+/)[0]) || 0;

      const { stdout: st } = await execFileP(
        "docker",
        ["stats", "--no-stream", "--format", "{{.Name}}\t{{.MemUsage}}"],
        { timeout: 20_000 },
      );
      const lineas = st
        .trim()
        .split("\n")
        .filter((l) => l.includes(`multi-room-${PREFIJO}`));

      // "124.5MiB / 2GiB" → 124.5
      const memMB = lineas.reduce((suma, l) => {
        const m = l.match(/([\d.]+)(MiB|GiB|KiB)/);
        if (!m) return suma;
        const v = Number(m[1]);
        return suma + (m[2] === "GiB" ? v * 1024 : m[2] === "KiB" ? v / 1024 : v);
      }, 0);

      muestras.push({ t: Date.now(), load1, memMB, contenedores: lineas.length });
    } catch {
      // Una muestra perdida no invalida la prueba.
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/** Deja la máquina como estaba: sin contenedores ni workspaces de la prueba. */
async function limpiar(): Promise<void> {
  console.log("\nLimpiando…");
  await Promise.all(previews.map((p) => p.stop().catch(() => {})));

  for (let i = 1; i <= N; i++) {
    const sala = `${PREFIJO}${String(i).padStart(2, "0")}`;
    await stopContainer(sala).catch(() => {});
    const dir = join(process.cwd(), "..", "workspaces", sala);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    await rm(`${dir}.home`, { recursive: true, force: true }).catch(() => {});
    await rm(`${dir}.turns.json`, { force: true }).catch(() => {});
  }
  console.log("  listo");
}

async function main(): Promise<void> {
  console.log(`=== Carga: ${N} salas simultáneas ===\n`);

  if (!(await isDockerAvailable())) {
    console.error("No hay Docker. Esta prueba mide contenedores, así que sin él no dice nada.");
    process.exit(1);
  }

  console.log("Preparando la imagen (solo la primera vez tarda)…");
  await ensureImage(join(process.cwd(), ".."));

  void muestrear();

  console.log(`\nLevantando ${N} salas a la vez…\n`);
  const t0 = Date.now();
  const resultados = await Promise.all(
    Array.from({ length: N }, (_, i) => levantarSala(i + 1)),
  );
  const total = Date.now() - t0;

  midiendo = false;
  await new Promise((r) => setTimeout(r, 100));

  // ── Resultados ────────────────────────────────────────────────────────────
  const ok = resultados.filter((r) => r.ok);
  const fallidas = resultados.filter((r) => !r.ok);

  for (const r of resultados) {
    const marca = r.ok ? "[ok]" : "[X] ";
    const detalle = r.ok ? `${(r.ms / 1000).toFixed(1)}s` : `murió en "${r.etapa}" — ${r.error}`;
    console.log(`  ${marca} ${r.sala}  ${detalle}`);
  }

  const loadMax = muestras.reduce((m, s) => Math.max(m, s.load1), 0);
  const memMax = muestras.reduce((m, s) => Math.max(m, s.memMB), 0);
  const nucleos = (await import("node:os")).cpus().length;
  const tiempos = ok.map((r) => r.ms / 1000).sort((a, b) => a - b);

  console.log(`\n─── Resumen ───`);
  console.log(`  Salas listas:      ${ok.length}/${N}`);
  console.log(`  Tiempo total:      ${(total / 1000).toFixed(1)}s`);
  if (tiempos.length) {
    console.log(
      `  Por sala:          ${tiempos[0].toFixed(1)}s la más rápida · ` +
        `${tiempos[tiempos.length - 1].toFixed(1)}s la más lenta`,
    );
  }
  console.log(`  Load máximo:       ${loadMax.toFixed(2)}  (${nucleos} núcleos)`);
  console.log(`  Memoria máxima:    ${memMax.toFixed(0)} MB entre todos los contenedores`);
  if (ok.length) {
    console.log(`  Por sala:          ~${(memMax / ok.length).toFixed(0)} MB`);
  }

  // El veredicto, que es para lo que se corre esto.
  console.log(`\n─── Veredicto ───`);
  if (fallidas.length > 0) {
    console.log(`  NO aguanta ${N}: ${fallidas.length} sala(s) no llegaron a dev server.`);
    console.log(`  Antes del experimento: subir la máquina, o escalonar los arranques.`);
  } else if (loadMax > nucleos) {
    console.log(`  Aguanta ${N}, pero saturada: load ${loadMax.toFixed(2)} sobre ${nucleos} núcleos.`);
    console.log(`  Va a ir lento con gente real. Conviene escalonar los arranques.`);
  } else {
    console.log(`  Aguanta ${N} sin saturarse (load ${loadMax.toFixed(2)} de ${nucleos} núcleos).`);
  }

  await limpiar();
  process.exit(fallidas.length > 0 ? 1 : 0);
}

// Limpiar también si se interrumpe a media prueba: sin esto quedan N
// contenedores vivos comiéndose la máquina hasta que alguien los note.
for (const señal of ["SIGINT", "SIGTERM"] as const) {
  process.on(señal, () => {
    midiendo = false;
    void limpiar().then(() => process.exit(130));
  });
}

main().catch(async (err) => {
  console.error("\nLa prueba se cayó:", err);
  midiendo = false;
  await limpiar();
  process.exit(1);
});
