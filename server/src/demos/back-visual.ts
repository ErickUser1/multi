import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildApiMap } from "../engine/api-map.js";

/**
 * Demo Fase 6: verifica el analizador del back sobre un proyecto de mentira.
 * Uso: npm run demo:back
 *
 * No toca el server ni gasta API key — es el analizador puro contra archivos
 * escritos a mano, incluida la transición punteado → verde.
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

async function escribir(dir: string, rel: string, contenido: string): Promise<void> {
  const abs = join(dir, rel);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, contenido, "utf8");
}

async function main() {
  const dir = join(tmpdir(), `multi-back-${Date.now()}`);
  await mkdir(dir, { recursive: true });

  console.log("=== FASE 6 — el back visual ===\n");
  console.log("1. Front que llama, back que no existe (la card punteada)");

  await escribir(
    dir,
    "src/Menu.jsx",
    [
      "import { useEffect } from 'react'",
      "export function Menu() {",
      "  useEffect(() => { fetch('/api/pedidos').then(r => r.json()) }, [])",
      "  const crear = () => fetch('/api/pedidos', { method: 'POST' })",
      "  return <button onClick={crear}>Pedir</button>",
      "}",
    ].join("\n"),
  );
  // Ruido que NO debe aparecer como endpoint.
  await escribir(
    dir,
    "src/Nav.jsx",
    [
      "export const Nav = () => <a href='/precios'>Precios</a>",
      "// navegación, no backend:",
      "const ir = () => fetch('/assets/logo.png')",
    ].join("\n"),
  );

  let mapa = await buildApiMap(dir);
  const get = () => mapa.endpoints.find((e) => e.id === "GET /api/pedidos");
  const post = () => mapa.endpoints.find((e) => e.id === "POST /api/pedidos");

  check("detecta el GET que el front llama", !!get());
  check("lo marca como faltante (punteado)", get()?.status === "faltante");
  check("sabe desde dónde lo llaman", get()?.calls[0]?.file === "src/Menu.jsx");
  check("distingue el método de las opciones", post()?.status === "faltante");
  check(
    "ignora navegación y assets",
    !mapa.endpoints.some((e) => e.path === "/precios" || e.path.includes("logo")),
    mapa.endpoints.map((e) => e.id).join(", "),
  );

  console.log("\n2. El agente crea el endpoint → la card pasa a verde");
  await escribir(
    dir,
    "server/api.js",
    [
      "import express from 'express'",
      "const app = express()",
      "app.get('/api/pedidos', (req, res) => res.json([]))",
      "app.post('/api/pedidos', (req, res) => res.status(201).json({ ok: true }))",
    ].join("\n"),
  );

  mapa = await buildApiMap(dir);
  check("el GET ahora está conectado (verde)", get()?.status === "conectado");
  check("el POST también", post()?.status === "conectado");
  check("sabe dónde vive", get()?.definedAt?.file === "server/api.js");

  console.log("\n3. Endpoint que existe pero nadie llama (huérfano)");
  await escribir(dir, "server/extra.js", "router.delete('/api/viejo', h)");
  mapa = await buildApiMap(dir);
  const huerfano = mapa.endpoints.find((e) => e.id === "DELETE /api/viejo");
  check("lo detecta", !!huerfano);
  check("lo marca como huérfano", huerfano?.status === "huerfano");

  console.log("\n4. Rutas por convención de archivo (Next/Nuxt)");
  await escribir(dir, "src/App.jsx", "fetch('/api/usuarios')");
  await escribir(dir, "app/api/usuarios/route.ts", "export async function GET() { return [] }");
  mapa = await buildApiMap(dir);
  const usuarios = mapa.endpoints.find((e) => e.id === "GET /api/usuarios");
  check("la ruta sale del path del archivo", usuarios?.status === "conectado", usuarios?.status);

  console.log("\n5. Lo accionable primero");
  await escribir(dir, "src/Otro.jsx", "fetch('/api/sin-back')");
  mapa = await buildApiMap(dir);
  check("los faltantes encabezan la lista", mapa.endpoints[0]?.status === "faltante");

  await rm(dir, { recursive: true, force: true });
  console.log(`\n${pass} pasaron, ${fail} fallaron\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("falló:", e.message);
  process.exit(1);
});
