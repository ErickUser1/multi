import { mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// Raíz donde vive el workspace de cada sala. Gitignored en el repo de Multi;
// cada workspace tiene SU propio git (el estado del proyecto del usuario).
export const WORKSPACES_ROOT = join(process.cwd(), "..", "workspaces");

export interface Workspace {
  roomId: string;
  dir: string;
  /** Cómo arrancar su dev server. El motor no asume el stack — el proyecto lo declara. */
  launch: { command: string; args: string[]; portEnv?: string };
}

/**
 * Crea el workspace de una sala: carpeta + git init + un proyecto de arranque.
 *
 * En el producto real, el AGENTE scaffoldea el proyecto desde cero según el stack
 * que pida el usuario (cero molde). Aquí, para la Fase 0, sembramos un proyecto
 * Vite+React mínimo SOLO para probar que el motor (workspace + preview + HMR) jala.
 * `seedProject` es reemplazable/omitible: una sala real puede nacer vacía.
 */
export async function createWorkspace(
  roomId: string,
  opts: { seed?: boolean; clean?: boolean } = {},
): Promise<Workspace> {
  const dir = join(WORKSPACES_ROOT, roomId);

  if (opts.clean && existsSync(dir)) {
    await rm(dir, { recursive: true, force: true });
  }
  await mkdir(dir, { recursive: true });

  await execFileP("git", ["init", "-q"], { cwd: dir });
  // Config local para que los commits del motor no dependan del git global del user.
  await execFileP("git", ["config", "user.name", "Multi"], { cwd: dir });
  await execFileP("git", ["config", "user.email", "motor@multi.local"], { cwd: dir });

  if (opts.seed !== false) {
    await seedViteReact(dir);
  }

  return {
    roomId,
    dir,
    // El dev server de Vite sirve en un puerto; se lo pasamos por variable PORT.
    launch: { command: "npm", args: ["run", "dev"], portEnv: "PORT" },
  };
}

/** Siembra un proyecto Vite+React mínimo (proyecto de PRUEBA de la Fase 0). */
async function seedViteReact(dir: string): Promise<void> {
  const files: Record<string, string> = {
    // Sin esto, cada commit por turno intentaría meter node_modules (miles de
    // archivos): los turnos tardan una eternidad o revientan, y nunca commitean.
    ".gitignore": ["node_modules/", "dist/", ".vite/", "*.log", ""].join("\n"),
    "package.json": JSON.stringify(
      {
        name: "sala-app",
        private: true,
        version: "0.0.0",
        type: "module",
        scripts: {
          // host: expone el server en la red (necesario para verlo desde Windows vía WSL);
          // strictPort: falla si el puerto está ocupado en vez de saltar solo.
          dev: "vite --host --strictPort",
        },
        dependencies: {
          react: "^19.2.0",
          "react-dom": "^19.2.0",
        },
        devDependencies: {
          "@vitejs/plugin-react": "^6.0.0",
          vite: "^8.1.0",
        },
      },
      null,
      2,
    ),
    "vite.config.js": [
      "import { defineConfig } from 'vite'",
      "import react from '@vitejs/plugin-react'",
      "",
      "// El puerto llega por la variable PORT que le pasa el motor (preview.ts).",
      "export default defineConfig({",
      "  plugins: [react()],",
      "  server: { port: Number(process.env.PORT) || 5173, host: true, strictPort: true },",
      "})",
      "",
    ].join("\n"),
    "index.html": [
      "<!doctype html>",
      '<html lang="es">',
      "  <head>",
      '    <meta charset="UTF-8" />',
      '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
      "    <title>Sala · Multi</title>",
      "  </head>",
      "  <body>",
      '    <div id="root"></div>',
      '    <script type="module" src="/src/main.jsx"></script>',
      "  </body>",
      "</html>",
      "",
    ].join("\n"),
    "src/main.jsx": [
      "import { StrictMode } from 'react'",
      "import { createRoot } from 'react-dom/client'",
      "import App from './App.jsx'",
      "",
      "createRoot(document.getElementById('root')).render(",
      "  <StrictMode>",
      "    <App />",
      "  </StrictMode>,",
      ")",
      "",
    ].join("\n"),
    "src/App.jsx": [
      "export default function App() {",
      "  return (",
      "    <main style={{ fontFamily: 'system-ui', padding: 48, textAlign: 'center' }}>",
      "      <h1>Hola Multi</h1>",
      "      <p>El motor funciona. Este preview se actualiza solo.</p>",
      "    </main>",
      "  )",
      "}",
      "",
    ].join("\n"),
  };

  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content, "utf8");
  }
}
