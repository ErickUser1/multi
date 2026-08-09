import { parsePreviewUrl } from "../engine/proxy.js";

/**
 * Demo: qué peticiones van al preview y cuáles se quedan en la Sala.
 * Uso: npm run demo:proxy-rutas
 *
 * Este ruteo ya causó tres bugs distintos, todos por lo mismo: una lista blanca
 * de lo que sí va al preview, que se quedaba corta en cuanto el proyecto pedía
 * algo nuevo.
 *
 *   1. El preview salía en blanco: los imports de módulos ES no mandan Referer,
 *      así que no se podía saber de qué sala eran. Se resolvió con la cookie.
 *   2. El HMR no llegaba: Vite abre su WebSocket contra "/", que la lista
 *      rechazaba, y el preview no se actualizaba solo.
 *   3. Las imágenes salían rotas: el agente puso un logo en public/ y el `<img>`
 *      pedía "/palantir-logo.png", que tampoco estaba en la lista. El archivo
 *      existía, la ruta era correcta, y el navegador recibía el HTML de la Sala.
 *
 * Ahora la lista es al revés: se enumera lo de la SALA, que es nuestro y solo
 * cambia cuando lo cambiamos nosotros. Lo del preview no se puede enumerar
 * porque depende del proyecto que construya el agente.
 *
 * No necesita red ni servidor: prueba la función que decide.
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

const COOKIE = { cookie: "multi_room=taco-fiesta-42" };
const REFERER = { referer: "http://localhost:4000/preview/taco-fiesta-42/" };

/** Va al preview de esa sala. */
function alPreview(url: string, headers: Record<string, string> = COOKIE): boolean {
  return parsePreviewUrl(url, headers)?.roomId === "taco-fiesta-42";
}

/** Se queda en la Sala (Fastify la atiende). */
function aLaSala(url: string, headers: Record<string, string> = COOKIE): boolean {
  return parsePreviewUrl(url, headers) === null;
}

function main() {
  console.log("=== Qué va al preview y qué se queda en la Sala ===\n");

  console.log("1. La ruta explícita del preview");
  {
    const r = parsePreviewUrl("/preview/taco-fiesta-42/index.html", {});
    check("saca la sala de la URL", r?.roomId === "taco-fiesta-42");
    check("y el resto de la ruta", r?.rest === "/index.html", r?.rest ?? "");
    check(
      "sin cookie ni referer: la URL basta",
      alPreview("/preview/taco-fiesta-42/algo.js", {}),
    );
    check(
      "un id inventado no pasa (SSRF)",
      parsePreviewUrl("/preview/../../etc/passwd", {}) === null,
    );
  }

  console.log("\n2. Lo que Vite pide desde la raíz (bugs 1 y 2)");
  {
    check("el cliente de HMR", alPreview("/@vite/client"));
    check("los módulos del proyecto", alPreview("/src/main.tsx"));
    check("las dependencias", alPreview("/node_modules/.vite/deps/react.js"));
    check("el refresh de React", alPreview("/@react-refresh"));
    check("por referer también", alPreview("/src/App.tsx", REFERER));
  }

  console.log("\n3. Los archivos de public/ (el bug de la imagen)");
  {
    check("una imagen suelta en la raíz", alPreview("/palantir-logo.png"));
    check("el favicon", alPreview("/favicon.ico"));
    check("una fuente", alPreview("/fonts/inter.woff2"));
    check("un archivo con query", alPreview("/logo.png?v=2"));
    // Lo que importa: NO hay lista de extensiones. Cualquier cosa que el
    // proyecto sirva desde public/ tiene que llegar, sea lo que sea.
    check("un PDF", alPreview("/manual.pdf"));
    check("algo sin extensión", alPreview("/datos"));
  }

  console.log("\n4. Lo de la Sala nunca se va al preview");
  {
    check("la raíz es la Sala, aunque haya cookie", aLaSala("/"));
    check("y con query también", aLaSala("/?algo=1"));
    check("las rutas de la API", aLaSala("/rooms/taco-fiesta-42/history"));
    check("los modelos de un proveedor", aLaSala("/providers/openrouter/models"));
    check("el health", aLaSala("/health"));
    check("el socket", aLaSala("/socket.io/?EIO=4"));
    // /assets/ lo usan los dos (ahí compila la Sala, y ahí sirve Rails). Sin
    // referer del preview es de la Sala; con él, del proyecto (ver caso 5).
    check("los assets compilados de la Sala", aLaSala("/assets/index-abc123.js"));
  }

  console.log("\n5. Cualquier stack, no solo Vite");
  {
    // La sala nace vacía y el agente elige el stack, así que el proxy no puede
    // conocer las rutas de cada framework. Antes la lista blanca era literalmente
    // de Vite (/@vite/, /src/, /node_modules/), y un proyecto en Django o Next
    // habría fallado igual que la imagen.
    check("Django estático", alPreview("/static/css/main.css"));
    check("Django media", alPreview("/media/uploads/foto.jpg"));
    check("Next.js", alPreview("/_next/static/chunks/main.js"));
    check("Remix", alPreview("/build/_shared/chunk.js"));
    check("SvelteKit", alPreview("/_app/immutable/entry/start.js"));
    check("Astro", alPreview("/_astro/index.abc.css"));
    check("Rails", alPreview("/assets/application-abc.js", REFERER));
    check("un livereload cualquiera", alPreview("/livereload.js"));
  }

  console.log("\n6. Sin sala identificada no hay a dónde mandarlo");
  {
    // Alguien que abre localhost:4000 sin haber entrado a ninguna sala: sus
    // peticiones tienen que caer en la Sala, no en un preview inexistente.
    check("una imagen sin cookie ni referer", aLaSala("/logo.png", {}));
    check("un módulo sin cookie ni referer", aLaSala("/src/main.tsx", {}));
  }

  console.log(`\n${pass} pasaron, ${fail} fallaron\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
