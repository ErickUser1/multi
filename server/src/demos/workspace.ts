import { spawn } from "node:child_process";
import { createWorkspace } from "../engine/workspace.js";
import { startPreview } from "../engine/preview.js";

/**
 * Demo Fase 0: crea un workspace de sala, instala deps, arranca su preview.
 * Uso: npm run demo:workspace
 *
 * Test de éxito: abrir la URL impresa en el navegador → ver "Hola Multi".
 * Editar workspaces/demo-fase0/src/App.jsx a mano → el navegador se actualiza solo (HMR).
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

  console.log(`\n▸ creando workspace de la sala "${roomId}"…`);
  const ws = await createWorkspace(roomId, { clean: true });
  console.log(`  workspace en: ${ws.dir}`);

  console.log(`\n▸ instalando dependencias (npm install)… (puede tardar)`);
  await run("npm", ["install"], ws.dir);

  console.log(`\n▸ arrancando el preview…`);
  const preview = await startPreview(ws);

  console.log(`\n✓ PREVIEW LISTO`);
  console.log(`  Abre en tu navegador:  ${preview.url}`);
  console.log(`\n  Prueba el HMR: edita este archivo y guarda —`);
  console.log(`    ${ws.dir}/src/App.jsx`);
  console.log(`  El navegador debe actualizarse solo, sin recargar.\n`);
  console.log(`  (Ctrl+C para detener)\n`);

  // Mantener vivo hasta Ctrl+C; limpiar al salir.
  const shutdown = async () => {
    console.log(`\n▸ deteniendo preview…`);
    await preview.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("\n✗ demo falló:", err);
  process.exit(1);
});
