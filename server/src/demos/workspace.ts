import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createWorkspace } from "../engine/workspace.js";
import { startPreview, detectLaunch } from "../engine/preview.js";

/**
 * Demo Fase 0: el ciclo de vida del workspace de una sala.
 * Uso: npm run demo:workspace
 *
 * Prueba lo que de verdad pasa en el producto: la sala NACE VACÍA (sin molde,
 * sin stack asumido) y el preview espera; cuando aparece un proyecto que se
 * puede levantar, arranca solo.
 *
 * Aquí el proyecto lo escribe la demo a mano; en la sala real lo scaffoldea el
 * agente con el stack que le pidas.
 */

function run(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit" });
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} salió con code ${code}`)),
    );
    child.once("error", reject);
  });
}

async function main() {
  const roomId = "demo-fase0";

  console.log(`\n1. La sala nace vacía`);
  const ws = await createWorkspace(roomId, { clean: true });
  console.log(`   workspace en: ${ws.dir}`);

  const sinProyecto = await detectLaunch(ws.dir);
  console.log(
    sinProyecto === null
      ? `   [ok] no hay nada que levantar todavía — el preview espera`
      : `   [X]  detectó un launch en una sala vacía: ${JSON.stringify(sinProyecto)}`,
  );
  if (sinProyecto !== null) process.exit(1);

  console.log(`\n2. Aparece un proyecto (en la sala real lo escribe el agente)`);
  const archivos: Record<string, string> = {
    "package.json": JSON.stringify(
      {
        name: "sala-app",
        private: true,
        type: "module",
        scripts: { dev: "vite --host --strictPort" },
        dependencies: { react: "^19.2.0", "react-dom": "^19.2.0" },
        devDependencies: { "@vitejs/plugin-react": "^6.0.0", vite: "^8.1.0" },
      },
      null,
      2,
    ),
    "vite.config.js": [
      "import { defineConfig } from 'vite'",
      "import react from '@vitejs/plugin-react'",
      "",
      "export default defineConfig({",
      "  plugins: [react()],",
      "  server: { port: Number(process.env.PORT) || 5173, host: true, strictPort: true },",
      "})",
      "",
    ].join("\n"),
    "index.html": [
      "<!doctype html>",
      '<html lang="es">',
      '  <head><meta charset="UTF-8" /><title>Sala</title></head>',
      '  <body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body>',
      "</html>",
      "",
    ].join("\n"),
    "src/main.jsx": [
      "import { createRoot } from 'react-dom/client'",
      "import App from './App.jsx'",
      "",
      "createRoot(document.getElementById('root')).render(<App />)",
      "",
    ].join("\n"),
    "src/App.jsx": [
      "export default function App() {",
      "  return <main style={{ fontFamily: 'system-ui', padding: 48 }}><h1>Hola Multi</h1></main>",
      "}",
      "",
    ].join("\n"),
  };

  for (const [rel, contenido] of Object.entries(archivos)) {
    const full = join(ws.dir, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, contenido, "utf8");
  }

  const launch = await detectLaunch(ws.dir);
  console.log(
    launch
      ? `   [ok] ahora sí se puede levantar: ${launch.command} ${launch.args.join(" ")}`
      : `   [X]  no detectó cómo levantarlo`,
  );
  if (!launch) process.exit(1);

  console.log(`\n3. Instalando dependencias… (puede tardar)`);
  await run("npm", ["install"], ws.dir);

  console.log(`\n4. Arrancando el preview…`);
  const preview = await startPreview(ws, launch);

  console.log(`\n   PREVIEW LISTO — abre: ${preview.url}`);
  console.log(`   Prueba el HMR: edita ${ws.dir}/src/App.jsx y guarda.`);
  console.log(`   (Ctrl+C para detener)\n`);

  const shutdown = async () => {
    console.log(`\n   deteniendo preview…`);
    await preview.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("\ndemo falló:", err);
  process.exit(1);
});
