import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { runAgent } from "../agent/loop.js";
import { AnthropicProvider } from "../agent/providers/anthropic.js";
import { MockProvider } from "../agent/providers/mock.js";
import { WORKSPACES_ROOT } from "../engine/workspace.js";
import type { ModelProvider } from "../agent/providers/types.js";

/**
 * Demo Fase 1: corre el agente contra el workspace de la Fase 0.
 *
 * Uso:
 *   npm run demo:agent -- "cambia el título a Hola Mundo"
 *   npm run demo:agent -- --provider mock "pon el fondo azul"
 *
 * Requiere que el workspace "demo-fase0" exista (corre demo:workspace primero).
 * Con provider real requiere ANTHROPIC_API_KEY en server/.env.
 *
 * Test de éxito: si tienes el preview corriendo (demo:workspace en otra terminal),
 * el cambio del agente aparece SOLO en el navegador (HMR).
 */

async function loadEnv() {
  // Carga simple de .env sin dependencia externa.
  const envPath = join(process.cwd(), ".env");
  if (!existsSync(envPath)) return;
  const text = await readFile(envPath, "utf8");
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
    if (m) {
      const [, k, v] = m;
      if (!(k in process.env)) process.env[k] = v.replace(/^["']|["']$/g, "");
    }
  }
}

function parseArgs(argv: string[]): { provider: string; prompt: string } {
  const args = [...argv];
  let provider = process.env.ANTHROPIC_API_KEY ? "anthropic" : "mock";
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--provider") {
      provider = args[++i] ?? provider;
    } else {
      rest.push(args[i]);
    }
  }
  return { provider, prompt: rest.join(" ").trim() };
}

function makeProvider(name: string): ModelProvider {
  if (name === "mock") {
    // Guion mock: si piden un cambio de color/texto, edita App.jsx.
    return new MockProvider().scenario({
      match: () => true, // cualquier prompt → demuestra el edit
      reply: () => [
        { type: "text", text: "Voy a cambiar el App.jsx…" },
        {
          type: "tool_use",
          id: "",
          name: "edit_file",
          input: {
            path: "src/App.jsx",
            old_string: "El motor funciona. Este preview se actualiza solo.",
            new_string: "¡El agente editó esto! 🤖 (mock)",
          },
        },
      ],
    });
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.error("✗ falta ANTHROPIC_API_KEY. Usa --provider mock o crea server/.env");
    process.exit(1);
  }
  return new AnthropicProvider(key);
}

async function main() {
  await loadEnv();
  const { provider: providerName, prompt } = parseArgs(process.argv.slice(2));

  if (!prompt) {
    console.error('✗ dame un prompt. Ej: npm run demo:agent -- "cambia el título"');
    process.exit(1);
  }

  const workspaceDir = join(WORKSPACES_ROOT, "demo-fase0");
  if (!existsSync(workspaceDir)) {
    console.error("✗ no existe el workspace demo-fase0. Corre primero: npm run demo:workspace");
    process.exit(1);
  }

  const provider = makeProvider(providerName);
  console.log(`\n▸ provider: ${provider.name}`);
  console.log(`▸ prompt: "${prompt}"\n`);
  console.log("─".repeat(50));

  const result = await runAgent({
    provider,
    workspaceDir,
    messages: [],
    userMessage: prompt,
    callbacks: {
      onText: (t) => process.stdout.write(t),
      onToolStart: ({ name, input }) =>
        process.stdout.write(`\n  🔧 ${name}(${JSON.stringify(input).slice(0, 100)})\n`),
      onToolEnd: ({ name, result, isError }) =>
        process.stdout.write(`  ${isError ? "✗" : "✓"} ${name}: ${result.split("\n")[0].slice(0, 80)}\n`),
      onToolEvent: (e) => {
        if (e.type === "file:changed") process.stdout.write(`  📝 cambió: ${e.path}\n`);
      },
      onRetry: ({ attempt, waitMs, reason }) =>
        process.stdout.write(`\n  ⏳ retry ${attempt} (${reason}), esperando ${waitMs}ms…\n`),
    },
  });

  console.log("\n" + "─".repeat(50));
  console.log(`\n✓ terminó en ${result.turns} turno(s)`);
  console.log(`\nRespuesta final: ${result.finalText}\n`);
  console.log("Si tienes el preview corriendo, revisa el navegador — debió actualizarse solo.\n");
}

main().catch((err) => {
  console.error("\n✗ demo falló:", err);
  process.exit(1);
});
