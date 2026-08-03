import { createServer } from "node:http";
import { OpenAICompatProvider } from "../agent/providers/openai-compat.js";
import { ProviderError, type Message } from "../agent/providers/types.js";

/**
 * Demo: el techo de salida se ajusta al saldo de la key.
 * Uso: npm run demo:presupuesto
 *
 * El bug que cubre: OpenRouter valida el saldo contra el MÁXIMO POSIBLE de
 * salida, no contra lo que la respuesta va a costar. Pedir max_tokens 8192
 * tumba con un 402 una petición que habría gastado 200 tokens. Con saldo bajo
 * pega constantemente y Multi parece roto cuando la falla es un número.
 *
 * Lo que se prueba es la diferencia entre los dos 402 distintos:
 *   - "can only afford N"  → hay saldo, el techo era muy alto. Se recorta y va.
 *   - sin ese dato         → no hay saldo. No hay número que sirva.
 *
 * No usa red ni API key: el servidor falso responde como el proveedor real.
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
 * Servidor que imita a OpenRouter cobrando por adelantado: rechaza con 402
 * mientras el max_tokens pedido no quepa en `saldo`, y en cuanto cabe responde
 * normal. Guarda cada techo que le pidieron para poder revisar la secuencia.
 */
function servidorConSaldo(saldo: number): Promise<{
  url: string;
  techosPedidos: () => number[];
  cerrar: () => void;
}> {
  const techos: number[] = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        const body = JSON.parse(raw);
        techos.push(body.max_tokens);

        if (body.max_tokens > saldo) {
          res.writeHead(402, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              error: {
                message: `This request requires more credits, or fewer max_tokens. You requested up to ${body.max_tokens} tokens, but can only afford ${saldo}.`,
              },
            }),
          );
          return;
        }

        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "listo" } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        techosPedidos: () => techos,
        cerrar: () => server.close(),
      });
    });
  });
}

/** Servidor sin saldo alguno: rechaza siempre, sin decir cuánto cabe. */
function servidorSinSaldo(): Promise<{ url: string; intentos: () => number; cerrar: () => void }> {
  let intentos = 0;
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        intentos++;
        res.writeHead(402, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: { message: "Insufficient credits. Add more at https://openrouter.ai/credits" },
          }),
        );
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        intentos: () => intentos,
        cerrar: () => server.close(),
      });
    });
  });
}

const mensajes: Message[] = [{ role: "user", content: [{ type: "text", text: "hola" }] }];

function proveedor(url: string) {
  return new OpenAICompatProvider({
    apiKey: "sk-or-v1-" + "x".repeat(32),
    baseUrl: url,
    defaultModel: "modelo/de-prueba",
    name: "prueba",
  });
}

async function main() {
  console.log("=== El techo de salida se ajusta al saldo ===\n");

  console.log("1. Con saldo corto: recorta y sale adelante");
  {
    const s = await servidorConSaldo(2000);
    const p = proveedor(s.url);

    const end = await p.stream({ messages: mensajes, maxTokens: 8192 });
    const techos = s.techosPedidos();

    check("el turno termina bien en vez de fallar", end.stopReason === "end_turn");
    check("el primer intento pidió lo que se le pasó", techos[0] === 8192, String(techos));
    check("hubo un segundo intento", techos.length >= 2, String(techos));
    check(
      "el segundo pidió menos de lo que el saldo aguanta",
      techos[1] !== undefined && techos[1] <= 2000,
      String(techos),
    );
    check(
      "y con margen: no pide justo el límite",
      techos[1] !== undefined && techos[1] < 2000,
      `pidió ${techos[1]} con saldo para 2000`,
    );
    s.cerrar();
  }

  console.log("\n2. No espera entre intentos: el saldo no crece solo");
  {
    const s = await servidorConSaldo(3000);
    const p = proveedor(s.url);

    const t0 = Date.now();
    await p.stream({ messages: mensajes, maxTokens: 8192 });
    const ms = Date.now() - t0;

    check("el recorte es inmediato, sin backoff", ms < 1000, `tardó ${ms}ms`);
    s.cerrar();
  }

  console.log("\n3. Avisa del reintento, para que se vea en la sala");
  {
    const s = await servidorConSaldo(2000);
    const p = proveedor(s.url);

    const avisos: Array<{ reason: string; waitMs: number }> = [];
    await p.stream({ messages: mensajes, maxTokens: 8192 }, {
      onRetry: (info) => avisos.push({ reason: info.reason, waitMs: info.waitMs }),
    });

    check("hubo aviso de reintento", avisos.length >= 1);
    check("dice que fue por presupuesto", avisos[0]?.reason === "presupuesto", JSON.stringify(avisos));
    check("y que no hay espera", avisos[0]?.waitMs === 0, JSON.stringify(avisos));
    s.cerrar();
  }

  console.log("\n4. Sin saldo de verdad: falla claro y NO se queda reintentando");
  {
    const s = await servidorSinSaldo();
    const p = proveedor(s.url);

    let err: unknown;
    try {
      await p.stream({ messages: mensajes, maxTokens: 8192 });
    } catch (e) {
      err = e;
    }

    check("falla", err !== undefined);
    check("como problema de cuenta, no de techo", (err as ProviderError)?.kind === "auth", String(err));
    check("sin reintentos inútiles", s.intentos() === 1, `${s.intentos()} intentos`);
    s.cerrar();
  }

  console.log("\n5. Un techo que ya cabe no se toca");
  {
    const s = await servidorConSaldo(100_000);
    const p = proveedor(s.url);

    await p.stream({ messages: mensajes, maxTokens: 4096 });
    const techos = s.techosPedidos();

    check("una sola llamada", techos.length === 1, String(techos));
    check("con el techo original", techos[0] === 4096, String(techos));
    s.cerrar();
  }

  console.log("\n6. Saldo tan bajo que ni recortando alcanza");
  {
    // Por debajo del piso el modelo se corta a media herramienta y devuelve un
    // JSON truncado: parece bug del agente cuando es falta de dinero.
    const s = await servidorConSaldo(50);
    const p = proveedor(s.url);

    let err: unknown;
    try {
      await p.stream({ messages: mensajes, maxTokens: 8192 });
    } catch (e) {
      err = e;
    }

    check("falla en vez de mandar un techo inservible", err !== undefined);
    check(
      "y lo dice como lo que es",
      String(err).includes("no cabe en el saldo"),
      String(err).slice(0, 90),
    );
    s.cerrar();
  }

  console.log(`\n${pass} pasaron, ${fail} fallaron\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
