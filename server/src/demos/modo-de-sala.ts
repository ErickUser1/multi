import { parseIntent, intentDeLaSala } from "../rooms.js";
import type { ChatIntent } from "../rooms.js";

/**
 * Demo: qué hace una sala con lo que alguien escribe, según su modo.
 * Uso: npm run demo:modo-de-sala
 *
 * Lo que importa comprobar aquí son las dos promesas del modo de una persona:
 * que escribir sin arroba despierte al agente, y que escribir DOS veces no
 * despierte a dos. Lo segundo es el bug que se vio en producción, donde alguien
 * acabó con dos agentes por saludar antes de pedir algo.
 *
 * Y la tercera, que es la que se rompe sin querer: que en multi nada cambie.
 *
 * No necesita red, ni base, ni servidor: las dos funciones son puras.
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

/** Lo que haría la sala con ese texto. `primerAgente` undefined = sala sin agentes. */
function loQuePasa(
  texto: string,
  modo: "solo" | "multi",
  primerAgente?: string,
  anclado = false,
  personas = 2,
): ChatIntent {
  return intentDeLaSala(parseIntent(texto, anclado), { modo, texto, primerAgente, personas });
}

function main() {
  console.log("\n=== qué hace la sala con lo que escribes ===\n");

  console.log("1. En multijugador no cambia NADA");
  {
    // Esta es la que se rompe sin querer: 65 salas ya existían cuando esto se
    // agregó, y todas se comportan así.
    check("escribir sin mención es plática", loQuePasa("hola", "multi").kind === "talk");
    check(
      "y sigue siendo plática aunque haya un agente",
      loQuePasa("hola", "multi", "agente-1").kind === "talk",
    );
    check("@agente lanza uno nuevo", loQuePasa("@agente hazme algo", "multi").kind === "spawn");
    const a = loQuePasa("@agente-2 cambia el color", "multi", "agente-1");
    check("@agente-2 le habla a ese", a.kind === "address" && a.agentName === "agente-2");
  }

  console.log("\n2. En una persona, escribir despierta al agente");
  {
    // El caso de las cuatro personas que llegaron solas: escribieron sin
    // mencionar y no pasó nada.
    const primero = loQuePasa("hazme una landing", "solo");
    check("sin agentes todavía, nace el primero", primero.kind === "spawn");
    check(
      "y se lleva el texto completo",
      primero.kind === "spawn" && primero.task === "hazme una landing",
      primero.kind === "spawn" ? primero.task : primero.kind,
    );

    const segundo = loQuePasa("ahora ponlo azul", "solo", "agente-1");
    check("con uno ya adentro, le habla a ÉL", segundo.kind === "address");
    check(
      "y no nace otro",
      segundo.kind === "address" && segundo.agentName === "agente-1",
      segundo.kind,
    );
  }

  console.log("\n3. Y saludar dos veces no crea dos agentes");
  {
    // El bug tal cual: "@agente Hola" despertó a agente-1, y el mensaje
    // siguiente despertó a agente-2, que fue el que trabajó. El primero se
    // quedó ahí sin hacer nada, cobrado.
    const uno = loQuePasa("hola", "solo");
    check("el primer mensaje crea agente-1", uno.kind === "spawn");
    const dos = loQuePasa("hola?", "solo", "agente-1");
    check("el segundo NO crea agente-2", dos.kind === "address", dos.kind);
    const tres = loQuePasa("oye", "solo", "agente-1");
    check("ni el tercero", tres.kind === "address", tres.kind);
  }

  console.log("\n4. La arroba no desaparece, solo deja de ser obligatoria");
  {
    // Es lo que permite lanzar trabajo en paralelo, y tiene que seguir
    // sirviendo en una sala de una persona.
    check(
      "@agente sigue lanzando uno nuevo",
      loQuePasa("@agente otra cosa aparte", "solo", "agente-1").kind === "spawn",
    );
    const dirigido = loQuePasa("@agente-2 tú sigue", "solo", "agente-1");
    check(
      "y @agente-2 le habla a ese, no al primero",
      dirigido.kind === "address" && dirigido.agentName === "agente-2",
    );
  }

  console.log("\n5. Señalar un elemento es hablarle al que está");
  {
    // Un anclado ya venía como orden, pero como `spawn`: con el primero ocupado
    // habría nacido un segundo, que es justo lo que este modo quita.
    const anclado = loQuePasa("hazlo más grande", "solo", "agente-1", true);
    check("con un agente adentro, va para él", anclado.kind === "address", anclado.kind);
    check(
      "sin agentes, nace el primero",
      loQuePasa("hazlo más grande", "solo", undefined, true).kind === "spawn",
    );
    // En multi se queda como estaba: el click implica la orden, y reusa al que
    // esté libre (eso lo decide el handler, no esto).
    check(
      "en multi sigue siendo orden, como siempre",
      loQuePasa("hazlo más grande", "multi", "agente-1", true).kind === "spawn",
    );
  }

  console.log("\n6. Sola en multijugador, escribir igual despierta al agente");
  {
    // El caso real: llegó sola, tocó Multijugador y su primer mensaje ("you are
    // goinh yo help me to build a flutter") se quedó sin respuesta. Se fue.
    const meg = loQuePasa("you are goinh yo help me to build a flutter", "multi", undefined, false, 1);
    check("su primer mensaje hace nacer al agente", meg.kind === "spawn", meg.kind);
    const siguiente = loQuePasa("ponlo azul", "multi", "agente-1", false, 1);
    check(
      "y el siguiente le habla al mismo",
      siguiente.kind === "address" && siguiente.agentName === "agente-1",
      siguiente.kind,
    );
    check(
      "con dos personas vuelve a ser plática",
      loQuePasa("oye, ¿ya viste?", "multi", "agente-1", false, 2).kind === "talk",
    );
  }

  console.log(`\n${pass} pasaron, ${fail} fallaron\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
