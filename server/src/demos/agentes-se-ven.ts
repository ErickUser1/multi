import { AgentRegistry, resumenDeOtros } from "../engine/agents.js";

/**
 * Demo: un agente que empieza un turno sabe qué están haciendo los demás.
 * Uso: npm run demo:agentes-se-ven
 *
 * El bug que cubre, visto en una sesión real: alguien lanza un agente que se
 * pone a instalar dependencias; segundos después alguien lanza otro, que mira el
 * workspace, lo ve vacío (el primero todavía no escribe nada) y se pone a montar
 * el proyecto también. Dos agentes haciendo lo mismo desde el segundo cero.
 *
 * No necesita red ni API key: prueba la construcción del resumen, que es donde
 * está la lógica.
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

function main() {
  console.log("=== Los agentes se ven entre sí ===\n");

  console.log("1. Agente solo: no se le cuenta nada");
  {
    const reg = new AgentRegistry();
    const a1 = reg.spawn("monta el proyecto")!;
    const r = resumenDeOtros(reg, a1.id, []);
    check("sin resumen cuando trabaja solo", r === null, String(r).slice(0, 60));
  }

  console.log("\n2. El caso del bug: el otro instala y todavía no escribe nada");
  {
    const reg = new AgentRegistry();
    const a1 = reg.spawn("crea una landing de un videojuego")!;
    const a2 = reg.spawn("haz una sección de personajes")!;

    // a1 lleva segundos instalando: no ha tocado ningún archivo todavía.
    const r = resumenDeOtros(reg, a2.id, []);
    check("al segundo SÍ se le avisa", r !== null);
    check("dice quién es el otro", !!r?.includes(a1.name), r ?? "");
    check(
      "y qué le pidieron — aunque no haya escrito nada",
      !!r?.includes("crea una landing"),
      r ?? "",
    );
    check("le dice que no rehaga el trabajo", !!r?.includes("No rehagas"));
  }

  console.log("\n3. Distingue lo que se escribe AHORA de lo ya tocado");
  {
    const reg = new AgentRegistry();
    const a1 = reg.spawn("el header")!;
    const a2 = reg.spawn("el footer")!;

    const r = resumenDeOtros(reg, a2.id, [
      { agentId: a1.id, path: "src/Nav.tsx", escribiendoAhora: true },
      { agentId: a1.id, path: "src/App.tsx", escribiendoAhora: false },
    ]);
    check("marca el archivo en vuelo", !!r?.includes("escribiendo ahora: src/Nav.tsx"), r ?? "");
    check("y el que ya soltó", !!r?.includes("ya tocó: src/App.tsx"), r ?? "");
    // Sin saltos de línea: el texto se envuelve a 80 columnas y una frase puede
    // quedar partida en dos líneas.
    const seguido = r?.replace(/\s+/g, " ") ?? "";
    check(
      "explica qué hacer con cada uno",
      seguido.includes("déjalo") && seguido.includes("léelo antes de tocarlo"),
    );
  }

  console.log("\n4. Lo que el otro CONTÓ también viaja");
  {
    const reg = new AgentRegistry();
    const a1 = reg.spawn("la sección de personajes")!;
    const a2 = reg.spawn("agrega a Virgilio")!;

    const dijo = new Map([
      [
        a1.id,
        "Puse los personajes en src/data/personajes.ts como array tipado, cada uno con nombre, círculo y pecado.",
      ],
    ]);
    const r = resumenDeOtros(reg, a2.id, [], dijo);
    check(
      "el segundo se entera de la decisión, no solo del archivo",
      !!r?.includes("src/data/personajes.ts"),
      r ?? "",
    );
    check("se marca como algo que dijo", !!r?.includes('dijo: "'), r ?? "");
  }

  console.log("\n5. Los que terminaron SIN dejar rastro no estorban");
  {
    const reg = new AgentRegistry();
    const a1 = reg.spawn("ya terminé")!;
    const a2 = reg.spawn("sigo trabajando")!;
    reg.finish(a1.id);

    const r = resumenDeOtros(reg, a2.id, []);
    check("no se menciona a un agente libre y sin archivos", r === null, r ?? "");
  }

  console.log("\n6. Pero el que terminó Y dejó archivos SÍ se cuenta");
  {
    // El bug: un agente pasa a idle en cuanto cierra su turno, así que filtrar
    // por estado lo borraba del resumen justo después de hacer lo que el
    // siguiente necesita saber. Visto de verdad: uno construyó el nivel de un
    // juego, terminó, y minutos después otro empezó su propia versión.
    const reg = new AgentRegistry();
    const a1 = reg.spawn("haz el nivel 1")!;
    const a2 = reg.spawn("conecta el menú")!;
    reg.finish(a1.id);

    const r = resumenDeOtros(reg, a2.id, [
      { agentId: a1.id, path: "src/game/Game.tsx", escribiendoAhora: false },
      { agentId: a1.id, path: "src/game/engine.ts", escribiendoAhora: false },
    ]);

    check("aparece aunque ya no esté trabajando", r !== null);
    check("con los archivos que dejó", !!r?.includes("src/game/Game.tsx"), r ?? "");
    check("y se distingue que ya terminó", !!r?.includes("ya terminó"), r ?? "");
  }

  console.log("\n7. Los archivos siguen mandando: sin rastro reciente, nadie aparece");
  {
    // La ventana de tiempo es la que filtra ahora, no el estado. Si el agente
    // terminó hace rato, `trabajoRecienteDeOtros` ya no devuelve sus archivos y
    // desaparece solo — para eso está `git log`, que sí guarda todo.
    const reg = new AgentRegistry();
    const a1 = reg.spawn("algo de hace rato")!;
    const a2 = reg.spawn("lo de ahora")!;
    reg.finish(a1.id);

    const r = resumenDeOtros(reg, a2.id, []);
    check("fuera de la ventana no se acumula", r === null, r ?? "");
  }

  console.log("\n8. No se cuenta a sí mismo");
  {
    const reg = new AgentRegistry();
    const a1 = reg.spawn("lo mío")!;
    const r = resumenDeOtros(reg, a1.id, [
      { agentId: a1.id, path: "src/App.tsx", escribiendoAhora: true },
    ]);
    check("un agente no se ve a sí mismo como 'otro'", r === null, r ?? "");
  }

  console.log(`\n${pass} pasaron, ${fail} fallaron\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
