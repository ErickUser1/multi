import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../agent/loop.js";
import type { Message, ModelProvider, StreamEvent } from "../agent/providers/types.js";

/**
 * Demo: un turno que se corta NO tira lo que ya hizo.
 * Uso: npm run demo:turno-cortado
 *
 * El bug que cubre, visto en una sesión real: un agente falló tres veces seguidas
 * con "la respuesta del modelo se cortó a media escritura". Cada intento releyó el
 * proyecto entero desde cero, porque para él ese turno nunca existió.
 *
 * La causa: runAgent hace una COPIA del historial que recibe, así que todo el turno
 * crece en un array local. En el camino de éxito y en el de interrupción se devuelve;
 * en el de error se iba con el stack y quedaba inalcanzable.
 *
 * No necesita red ni API key: usa un proveedor falso que se corta cuando le dices.
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

/**
 * Proveedor falso con un guion: una respuesta por vuelta del loop, y en la vuelta
 * que digas, revienta como lo hace un stream cortado a media generación.
 */
function proveedorConGuion(opts: {
  /** Qué responde en cada vuelta, en orden. */
  vueltas: Array<{ texto?: string; tool?: { name: string; input: Record<string, unknown> } }>;
  /** En qué vuelta (0-indexada) truena en vez de responder. */
  truenaEn: number;
}): { provider: ModelProvider; llamadas: () => Message[][] } {
  const llamadas: Message[][] = [];
  let vuelta = 0;

  const provider: ModelProvider = {
    name: "falso",
    defaultModel: "falso/modelo",
    async stream(params): Promise<Extract<StreamEvent, { type: "end" }>> {
      // Guardar lo que se le mandó: así se comprueba que el historial rescatado
      // es válido para el proveedor (cada tool_use con su tool_result).
      llamadas.push(params.messages);

      const actual = vuelta++;
      if (actual === opts.truenaEn) {
        // Mismo mensaje que produce anthropic.ts cuando el JSON llega truncado.
        throw new Error(
          'la respuesta del modelo se cortó a media escritura (tool "write_file").',
        );
      }

      const guion = opts.vueltas[actual];
      if (!guion) throw new Error(`el guion no tiene vuelta ${actual}`);

      if (guion.tool) {
        return {
          type: "end",
          stopReason: "tool_use",
          message: {
            role: "assistant",
            content: [
              { type: "tool_use", id: `tu_${actual}`, name: guion.tool.name, input: guion.tool.input },
            ],
          },
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      }

      return {
        type: "end",
        stopReason: "end_turn",
        message: { role: "assistant", content: [{ type: "text", text: guion.texto ?? "listo" }] },
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  };

  return { provider, llamadas: () => llamadas };
}

/** Cada tool_use del historial tiene su tool_result. Es lo que la API exige. */
function toolsEmparejadas(messages: Message[]): boolean {
  const usados = new Set<string>();
  const resueltos = new Set<string>();
  for (const m of messages) {
    for (const c of m.content) {
      if (c.type === "tool_use") usados.add(c.id);
      if (c.type === "tool_result") resueltos.add(c.tool_use_id);
    }
  }
  for (const id of usados) if (!resueltos.has(id)) return false;
  return true;
}

async function main() {
  console.log("=== Un turno cortado conserva lo que hizo ===\n");
  const dir = await mkdtemp(join(tmpdir(), "multi-turno-"));

  try {
    console.log("1. El caso del bug: se corta después de trabajar");
    {
      // Vuelta 0: lee un archivo (tool). Vuelta 1: truena a media escritura.
      const { provider } = proveedorConGuion({
        vueltas: [{ tool: { name: "glob", input: { pattern: "*" } } }],
        truenaEn: 1,
      });

      let rescatado: Message[] | null = null;
      let lanzo = false;
      try {
        await runAgent({
          provider,
          workspaceDir: dir,
          messages: [],
          userMessage: "haz el nivel 1",
          onProgreso: (msgs) => {
            rescatado = msgs;
          },
        });
      } catch {
        lanzo = true;
      }

      const msgs = rescatado as Message[] | null;
      check("el turno falla (sigue siendo un error)", lanzo);
      check("pero el historial sobrevive", msgs !== null);
      check(
        "y trae lo de la vuelta anterior, no solo el mensaje del usuario",
        (msgs?.length ?? 0) > 1,
        `${msgs?.length ?? 0} mensajes`,
      );
      check("con cada tool_use emparejado con su tool_result", toolsEmparejadas(msgs ?? []));
    }

    console.log("\n2. El historial rescatado le sirve al proveedor");
    {
      // Se toma el historial de un turno cortado y se manda en uno nuevo: si
      // estuviera mal formado (un tool_use suelto), la API real lo rechazaría.
      const { provider: p1 } = proveedorConGuion({
        vueltas: [{ tool: { name: "glob", input: { pattern: "*" } } }],
        truenaEn: 1,
      });

      let rescatado: Message[] = [];
      try {
        await runAgent({
          provider: p1,
          workspaceDir: dir,
          messages: [],
          userMessage: "haz el nivel 1",
          onProgreso: (m) => {
            rescatado = m;
          },
        });
      } catch {
        // esperado
      }

      const { provider: p2, llamadas } = proveedorConGuion({
        vueltas: [{ texto: "seguí donde iba" }],
        truenaEn: -1,
      });
      const r = await runAgent({
        provider: p2,
        workspaceDir: dir,
        messages: rescatado,
        userMessage: "continua",
      });

      const mandado = llamadas()[0] ?? [];
      check("el turno siguiente arranca sin errores", r.finalText === "seguí donde iba");
      check("y recibe el trabajo del turno cortado", mandado.length > 1, `${mandado.length} mensajes`);
      check("bien formado", toolsEmparejadas(mandado));
    }

    console.log("\n3. Si truena en la PRIMERA llamada no hay nada que rescatar");
    {
      const { provider } = proveedorConGuion({ vueltas: [], truenaEn: 0 });

      let rescatado: Message[] | null = null;
      try {
        await runAgent({
          provider,
          workspaceDir: dir,
          messages: [],
          userMessage: "haz algo",
          onProgreso: (m) => {
            rescatado = m;
          },
        });
      } catch {
        // esperado
      }

      const msgs = rescatado as Message[] | null;
      // Solo el mensaje del usuario: el turno no alcanzó a producir nada.
      check("el historial solo trae el mensaje del usuario", msgs?.length === 1, `${msgs?.length}`);
    }

    console.log("\n4. Un turno que termina bien sigue igual");
    {
      const { provider } = proveedorConGuion({
        vueltas: [{ texto: "terminé" }],
        truenaEn: -1,
      });

      let visto: Message[] | null = null;
      const r = await runAgent({
        provider,
        workspaceDir: dir,
        messages: [],
        userMessage: "haz algo",
        onProgreso: (m) => {
          visto = m;
        },
      });

      check("devuelve el resultado normal", r.finalText === "terminé");
      check("y el callback vio el mismo historial", visto === r.messages);
    }

    console.log("\n5. Una interrupción sigue conservando el contexto");
    {
      const ac = new AbortController();
      const provider: ModelProvider = {
        name: "falso",
        defaultModel: "falso/modelo",
        async stream(): Promise<Extract<StreamEvent, { type: "end" }>> {
          ac.abort();
          throw new Error("abortado");
        },
      };

      let visto: Message[] | null = null;
      const r = await runAgent({
        provider,
        workspaceDir: dir,
        messages: [],
        userMessage: "haz algo",
        signal: ac.signal,
        onProgreso: (m) => {
          visto = m;
        },
      });

      check("no lanza: interrumpir es un final legítimo", r.interrumpido === true);
      check("y el callback también lo vio", visto !== null);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  console.log(`\n${pass} pasaron, ${fail} fallaron\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
