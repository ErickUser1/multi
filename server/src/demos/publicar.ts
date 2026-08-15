import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createWorkspace } from "../engine/workspace.js";
import { detectBuild, buscarSalida } from "../engine/preview.js";
import { credencialDeDeploy, motivoDeFallo, sacarUrl } from "../engine/publicar.js";

/**
 * Demo: qué se compila y qué se sube al publicar la app de una sala.
 * Uso: npm run demo:publicar
 *
 * Lo que se prueba es la parte que decide, no el deploy: subir de verdad
 * necesitaría la credencial del dueño y dejaría una app publicada cada vez que
 * alguien corre el demo.
 *
 * Y esa parte es justo la que puede equivocarse en silencio: si elige mal la
 * carpeta, se sube el código fuente en vez de la app compilada, y el link que le
 * pasas a alguien muestra un directorio de archivos.
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

/** Escribe un package.json con los scripts que se le den. */
async function conScripts(dir: string, scripts: Record<string, string>): Promise<void> {
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x", scripts }, null, 2), "utf8");
}

async function main() {
  console.log("\n=== publicar la app de la sala ===\n");

  const ws = await createWorkspace("demo-publicar", { clean: true });

  console.log("1. Una sala vacía no tiene nada que compilar");
  check("sin proyecto no hay build", (await detectBuild(ws.dir)) === null);

  console.log("\n2. Se lee lo que el proyecto declara, sin asumir el stack");
  await conScripts(ws.dir, { dev: "vite", build: "vite build" });
  const build = await detectBuild(ws.dir);
  check("encontró el script", build?.args.join(" ") === "run build", JSON.stringify(build));

  console.log("\n3. Un proyecto que no compila no es un error");
  // Hay apps que se sirven tal cual: un index.html suelto no tiene build, y eso
  // es normal, no una falla.
  await conScripts(ws.dir, { dev: "vite" });
  check("sin script de build, no hay build", (await detectBuild(ws.dir)) === null);

  console.log("\n4. También se acepta el nombre que usa cada stack");
  await conScripts(ws.dir, { generate: "nuxt generate" });
  check("nuxt generate", (await detectBuild(ws.dir))?.args.join(" ") === "run generate");

  console.log("\n5. La carpeta de salida se busca DESPUÉS de compilar");
  check("antes del build no hay ninguna", buscarSalida(ws.dir) === null);

  await mkdir(join(ws.dir, "dist"), { recursive: true });
  check("después sí", buscarSalida(ws.dir) === "dist");

  console.log("\n6. Y se elige la de verdad cuando hay varias");
  // `public/` suele ser la FUENTE de los archivos estáticos, no la salida: si
  // ganara, se subiría el logo y nada más, sin la app compilada.
  await mkdir(join(ws.dir, "public"), { recursive: true });
  check("dist le gana a public", buscarSalida(ws.dir) === "dist");

  console.log("\n7. Sin credencial configurada no se publica en silencio");
  const antes = { ...process.env };
  delete process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  check("no hay credencial", credencialDeDeploy() === null);

  process.env.CLOUDFLARE_API_TOKEN = "falsa";
  check("con una sola tampoco alcanza", credencialDeDeploy() === null);

  process.env.CLOUDFLARE_ACCOUNT_ID = "falsa";
  check("con las dos ya sirve", credencialDeDeploy() !== null);
  process.env = antes;

  console.log("\n8. Cuando falla, se dice POR QUÉ");
  {
    /**
     * El bug que cubre: wrangler cierra su salida con una barra de guiones y la
     * ruta de su log, así que quedarse con la última línea daba un mensaje que
     * decía "────────────────────" y nada más. Pasó en el primer deploy real y
     * dejó sin ver el error, que era que el proyecto no existía todavía.
     */
    const salidaDeWrangler = [
      " ⛅️ wrangler 4.123.0",
      "────────────────────",
      "",
      '✘ [ERROR] The Pages project "una-sala" does not exist.',
      "",
      "  Maybe you intended to deploy a Worker project instead?",
      "",
      '🪵  Logs were written to "/work/.multi-home/.config/.wrangler/logs/x.log"',
    ].join("\n");

    const dicho = motivoDeFallo(salidaDeWrangler);
    check("saca el error de verdad", dicho.includes("does not exist"), dicho);
    check("y no la barra decorativa", !dicho.includes("─"), dicho);
  }

  console.log("\n9. El link que se comparte es el que no cambia");
  {
    /**
     * El bug que cubre: wrangler imprime la URL de ESE deploy, con un prefijo
     * distinto cada vez. Se mostró esa, y el link que se comparte se habría
     * quedado congelado en la versión de ese momento.
     */
    const salida = `✨ Deployment complete! Take a peek over at https://3217c505.una-sala.pages.dev`;
    const url = sacarUrl(salida, "una-sala");
    check("devuelve la estable", url === "https://una-sala.pages.dev", String(url));

    // Si wrangler responde algo que no es del proyecto esperado, se prefiere lo
    // que dijo antes que inventar una URL que a lo mejor no carga.
    const otra = sacarUrl("https://otra-cosa.pages.dev", "una-sala");
    check("si no es del proyecto, se respeta lo que dijo", otra === "https://otra-cosa.pages.dev");

    check("sin URL en la salida, no se inventa una", sacarUrl("todo mal", "una-sala") === null);
  }

  console.log(`\n${pass} pasaron, ${fail} fallaron\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\ndemo falló:", err);
  process.exit(1);
});
