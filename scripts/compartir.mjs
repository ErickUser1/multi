#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Abre tu Multi al mundo por un túnel, para que un compa entre con un link.
 *
 * Qué hace, en orden: compila la Sala si hace falta, levanta el server (que la
 * sirve en el MISMO puerto que la API — por eso basta un solo túnel), abre el
 * túnel y te imprime el link.
 *
 * Lo que hay que decir en voz alta: mientras esto corre, tu máquina está
 * expuesta a internet y cualquiera con el link entra a cualquier sala. Los ids
 * son impredecibles, pero no hay más puerta que esa. Para una sesión con tus
 * compas está bien; no lo dejes prendido.
 */

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUERTO = process.env.PORT ?? "4000";
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

function run(cmd, args, opts = {}) {
  return spawn(cmd, args, { cwd: raiz, stdio: "inherit", shell: process.platform === "win32", ...opts });
}

function esperar(child) {
  return new Promise((res, rej) => {
    child.once("exit", (code) => (code === 0 ? res() : rej(new Error(`salió con ${code}`))));
    child.once("error", rej);
  });
}

async function main() {
  // 1. La Sala compilada: sin esto el server no tiene qué servir y el túnel
  //    llevaría a una API pelona.
  if (!existsSync(join(raiz, "web", "dist", "index.html"))) {
    console.log("\n  Compilando la Sala (solo la primera vez)…\n");
    await esperar(run(NPM, ["run", "build"]));
  }

  console.log("\n  Levantando Multi…\n");
  const server = run(NPM, ["run", "serve"]);

  // 2. Esperar a que responda antes de abrir el túnel: si no, ngrok muestra
  //    un error de conexión y parece que todo falló.
  //
  //    El tope es alto porque el primer arranque hace varias cosas lentas:
  //    construir la imagen de Docker, y en WSL sobre /mnt/c hasta cargar las
  //    dependencias tarda (Windows traduciendo miles de lecturas).
  const listo = await esperarServer(`http://localhost:${PUERTO}/health`, 600_000);
  if (!listo) {
    console.error("\n  El server no respondió. Revisa los mensajes de arriba.\n");
    server.kill();
    process.exit(1);
  }

  console.log("\n  Abriendo el túnel…\n");
  const tunel = spawn("ngrok", ["http", PUERTO, "--log", "stdout", "--log-format", "json"], {
    cwd: raiz,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let anunciado = false;
  tunel.stdout.on("data", (d) => {
    for (const linea of String(d).split("\n")) {
      if (!linea.trim()) continue;
      let ev;
      try {
        ev = JSON.parse(linea);
      } catch {
        continue;
      }
      if (ev.url && !anunciado) {
        anunciado = true;
        anunciar(ev.url);
      }
      // ngrok reporta sus errores por el mismo canal.
      if (ev.lvl === "eror" || ev.err) {
        console.error(`  [ngrok] ${ev.err ?? ev.msg ?? linea}`);
      }
    }
  });
  tunel.stderr.on("data", (d) => process.stderr.write(`  [ngrok] ${d}`));

  tunel.once("exit", (code) => {
    if (!anunciado) {
      console.error(
        [
          "",
          `  ngrok no pudo abrir el túnel (salió con ${code}).`,
          "  Si es la primera vez, necesitas una cuenta gratis:",
          "    1. Regístrate en https://dashboard.ngrok.com/signup",
          "    2. Copia tu token y corre:  ngrok config add-authtoken TU_TOKEN",
          "",
        ].join("\n"),
      );
    }
    server.kill();
    process.exit(code ?? 1);
  });

  const cerrar = () => {
    console.log("\n  Cerrando…\n");
    tunel.kill();
    server.kill();
    process.exit(0);
  };
  process.on("SIGINT", cerrar);
  process.on("SIGTERM", cerrar);
}

function anunciar(url) {
  console.log(
    [
      "",
      "  ─────────────────────────────────────────────────────",
      "",
      `   Tu Multi está en:   ${url}`,
      "",
      "   Pásale ese link a tus compas y entran directo.",
      "   Cada quien pone su propia API key al llegar.",
      "",
      "   Mientras esto corra, tu máquina está abierta a",
      "   internet: cierra con Ctrl+C cuando terminen.",
      "",
      "  ─────────────────────────────────────────────────────",
      "",
    ].join("\n"),
  );
}

/** Sondea /health hasta que conteste. El primer arranque tarda (deps, Docker). */
async function esperarServer(url, timeoutMs) {
  const limite = Date.now() + timeoutMs;
  const inicio = Date.now();
  let aviso = 0;
  while (Date.now() < limite) {
    // Avisar cada 30s: sin esto parece colgado y la gente lo mata.
    const seg = Math.floor((Date.now() - inicio) / 1000);
    if (seg >= aviso + 30) {
      aviso = seg;
      console.log(`  …esperando al server (${seg}s). El primer arranque tarda.`);
    }
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (r.ok) return true;
    } catch {
      // todavía no levanta
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

main().catch((e) => {
  console.error("\n  Falló:", e.message, "\n");
  process.exit(1);
});
