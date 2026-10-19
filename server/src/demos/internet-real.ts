import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../agent/loop.js";
import { localRunner } from "../engine/runner.js";
import { AnthropicProvider } from "../agent/providers/anthropic.js";

/**
 * Prueba contra la API de verdad: el agente busca, escribe un archivo con lo que
 * encontró, y en un segundo turno sigue sobre ese historial.
 * Uso: MULTI_API_KEY=sk-ant-… npm run probar:internet
 *
 * Cuesta unos centavos (dos o tres búsquedas y unos miles de tokens). Lo que
 * revisa es lo que una demo con SSE falso no puede: que la API acepte de
 * regreso los bloques de la búsqueda a media vuelta (con el thinking fuera) y el
 * historial guardado en el turno siguiente. Cualquiera de los dos mal es un 400.
 */

async function main() {
  const key = process.env.MULTI_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.error("✗ falta MULTI_API_KEY (o ANTHROPIC_API_KEY)");
    process.exit(1);
  }
  const provider = new AnthropicProvider(key);
  const dir = await mkdtemp(join(tmpdir(), "multi-internet-real-"));
  const callbacks = {
    onServerTool: ({ name, input }: { name: string; input: Record<string, unknown> }) =>
      console.log(`  · ${name} ${JSON.stringify(input).slice(0, 100)}`),
    onToolStart: ({ name, input }: { name: string; input: Record<string, unknown> }) =>
      console.log(`  · ${name} ${JSON.stringify(input).slice(0, 100)}`),
  };

  try {
    console.log("1. Busca y escribe lo que encontró");
    const r1 = await runAgent({
      provider,
      workspaceDir: dir,
      runner: localRunner(dir),
      messages: [],
      userMessage:
        "Busca en internet cuántos habitantes tiene la Ciudad de México según el censo más reciente del INEGI y escríbelo en datos.txt con el link de la fuente. Nada más.",
      callbacks,
    });
    const archivo = await readFile(join(dir, "datos.txt"), "utf8").catch(() => "(no existe)");
    console.log(`\n  respuesta: ${r1.finalText}\n  datos.txt: ${archivo.trim()}`);

    console.log("\n2. Sigue sobre el mismo historial");
    const r2 = await runAgent({
      provider,
      workspaceDir: dir,
      runner: localRunner(dir),
      messages: r1.messages,
      userMessage: "¿De qué año es ese dato? Contesta en una línea, sin buscar otra vez.",
      callbacks,
    });
    console.log(`\n  respuesta: ${r2.finalText}`);

    const ok = archivo.includes("http") && r2.finalText.length > 0;
    console.log(ok ? "\n✓ todo bien" : "\n✗ algo no salió: revisa arriba");
    if (!ok) process.exit(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("✗", err);
  process.exit(1);
});
