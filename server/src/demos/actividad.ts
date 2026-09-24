import { accionDeComando, accionDeTool, type TipoDeAccion } from "../engine/actividad.js";

/**
 * Demo: la línea de actividad del chat dice qué hace el agente, no el comando.
 * Uso: npm run demo:actividad
 *
 * Los comandos de abajo son de salas reales. Con ellos el chat enseñaba cosas
 * como `$ cd /work && mv .env /tmp/.env.bak && npm create…` a gente que no
 * programa.
 *
 * No necesita red ni servidor.
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

function comando(cmd: string, esperado: TipoDeAccion): void {
  const real = accionDeComando(cmd);
  check(`${esperado.padEnd(14)} ${cmd}`, real === esperado, `-> ${real}`);
}

console.log("\n=== actividad del agente ===\n");

console.log("1. Comandos de salas reales");
comando("pwd && ls -la", "revisar");
comando("cd /work && mv .env /tmp/.env.bak && npm create vite@latest", "crearProyecto");
comando("cd /work && mv /tmp/.env.bak .env && ls -la && cat package.json", "mover");
comando("cd /work && npm install && npm install @supabase/supabase-js", "instalar");
comando("cd /work && npm run build 2>&1 | tail -20", "compilar");
comando("ps aux | grep -i vite", "revisar");
comando("date -d @1790106318", "revisar");
comando("cat /proc/14/status | grep -i ppid", "revisar");

console.log("\n2. Otros stacks y variantes");
comando("npx create-next-app@latest .", "crearProyecto");
comando("npx -y sv create .", "crearProyecto");
comando("yarn", "instalar");
comando("pip install -r requirements.txt", "instalar");
comando("npx tsc --noEmit", "compilar");
comando("git log --oneline", "historial");
comando("git status && git diff", "historial");
comando("git add -A && git commit -m 'cambio'", "git");
comando("git init", "crearProyecto");
comando("curl -s https://api.example.com/health", "conexion");
comando("node scripts/seed.js", "comando");

console.log("\n3. Las tools de archivos dicen solo el nombre");
const leer = accionDeTool("read_file", { path: "src/components/ShareDialog.tsx" });
check("leer ShareDialog.tsx", leer.tipo === "leer" && leer.archivo === "ShareDialog.tsx", JSON.stringify(leer));
check("y el detalle guarda la ruta completa", leer.detalle === "src/components/ShareDialog.tsx");
const sql = accionDeTool("sql", { sql: "create table x ()", descripcion: "crea-tabla-x" });
check("sql es cambiar la base", sql.tipo === "baseDeDatos");
check("ver_base es mirarla", accionDeTool("ver_base", {}).tipo === "verBase");
check("una tool desconocida no se pierde", accionDeTool("nueva_tool", {}).detalle === "nueva_tool");

console.log(`\n${pass} pasaron, ${fail} fallaron\n`);
process.exit(fail > 0 ? 1 : 0);
