import { writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspace } from "../engine/workspace.js";
import { detectBuild, buscarSalida } from "../engine/preview.js";
import {
  credencialDeDeploy,
  plataformasDisponibles,
  plataformaParaPublicar,
  plataformaDeUrl,
  explicarVercel,
  motivoDeFallo,
  publicarSala,
  sacarUrl,
  sacarUrlVercel,
  nombreDeApp,
  NoSePudoPublicar,
} from "../engine/publicar.js";
import { localRunner, type Runner } from "../engine/runner.js";
import { SqliteStorage } from "../storage/sqlite.js";

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
  delete process.env.VERCEL_TOKEN;
  delete process.env.VERCEL_TEAM;
  delete process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  check("no hay credencial", credencialDeDeploy() === null);

  process.env.CLOUDFLARE_API_TOKEN = "falsa";
  check("con una sola tampoco alcanza", credencialDeDeploy() === null);

  process.env.CLOUDFLARE_ACCOUNT_ID = "falsa";
  check("con las dos ya sirve", credencialDeDeploy()?.plataforma === "cloudflare");
  check("y solo se ofrece Cloudflare", JSON.stringify(plataformasDisponibles()) === '["cloudflare"]', JSON.stringify(plataformasDisponibles()));

  // Con el token de Vercel, gana Vercel aunque Cloudflare siga configurado.
  process.env.VERCEL_TOKEN = "falsa";
  const v = credencialDeDeploy();
  check("con VERCEL_TOKEN se publica en Vercel", v?.plataforma === "vercel", JSON.stringify(v));
  check("sin equipo, la cuenta del token", v?.plataforma === "vercel" && v.equipo === undefined);
  check("se ofrecen las dos, Vercel primero", JSON.stringify(plataformasDisponibles()) === '["vercel","cloudflare"]', JSON.stringify(plataformasDisponibles()));
  check("y se puede pedir Cloudflare", credencialDeDeploy("cloudflare")?.plataforma === "cloudflare");
  process.env.VERCEL_TEAM = "mi-equipo";
  const ve = credencialDeDeploy();
  check("con VERCEL_TEAM, en ese equipo", ve?.plataforma === "vercel" && ve.equipo === "mi-equipo");
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

  console.log("\n9b. El nombre lo elige quien publica");
  {
    check("Página tipo Uber!! → pagina-tipo-uber", nombreDeApp("Página tipo Uber!!") === "pagina-tipo-uber", String(nombreDeApp("Página tipo Uber!!")));
    check("ñ y espacios de sobra", nombreDeApp("  Año   Ñandú ") === "ano-nandu", String(nombreDeApp("  Año   Ñandú ")));
    check("solo símbolos no da nombre", nombreDeApp("!!! ???") === null);
    const largo = nombreDeApp("a".repeat(57) + "-bcd") ?? "";
    check("se corta a 58 y sin guion al final", largo.length <= 58 && !largo.endsWith("-"), largo);
    check("un id de sala se queda igual", nombreDeApp("vibe-fiesta-45") === "vibe-fiesta-45");

    // Los subdominios de pages.dev son de todo Cloudflare: si otra cuenta ya
    // tiene el nombre, el proyecto queda con un sufijo.
    const conSufijo = "✨ Deployment complete! Take a peek over at https://9f1c2a3b.mi-banco-3xk.pages.dev";
    check(
      "con sufijo de Cloudflare devuelve la estable con sufijo",
      sacarUrl(conSufijo, "mi-banco") === "https://mi-banco-3xk.pages.dev",
      String(sacarUrl(conSufijo, "mi-banco")),
    );
    check("sin hash ni sufijo", sacarUrl("https://mi-banco.pages.dev/", "mi-banco") === "https://mi-banco.pages.dev");

    const dir = await mkdtemp(join(tmpdir(), "multi-nombres-"));
    try {
      const db = new SqliteStorage(join(dir, "multi.db"));
      await db.init();
      const sala = (id: string) => ({ id, workspaceDir: join(dir, id), createdAt: 1, lastActiveAt: 1 });
      await db.createRoom(sala("vieja-sala-1"));
      await db.createRoom(sala("nueva-sala-2"));
      await db.createRoom(sala("otra-sala-3"));
      // Una que publicó antes de que se pudiera elegir: su proyecto se llama como su id.
      await db.setPublicacion("vieja-sala-1", "https://vieja-sala-1.pages.dev", "vieja-sala-1");
      await db.setPublicacion("nueva-sala-2", "https://mi-banco.pages.dev", "mi-banco");
      check("un nombre que usa otra sala está tomado", await db.nombreEnUso("mi-banco", "otra-sala-3"));
      check("pero no para la sala que lo tiene", !(await db.nombreEnUso("mi-banco", "nueva-sala-2")));
      check("el id de una sala vieja publicada está tomado", await db.nombreEnUso("vieja-sala-1", "otra-sala-3"));
      check("un nombre libre no", !(await db.nombreEnUso("mi-tienda", "otra-sala-3")));
      const leida = await db.getRoom("nueva-sala-2");
      check("se guarda y se lee el nombre", leida?.nombrePublicado === "mi-banco", JSON.stringify(leida));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  console.log("\n10. Una app con servidor propio no cabe, y se dice antes de subir");
  {
    /**
     * El caso real: el agente montó un Express con su base en un archivo, la
     * sala lo vio funcionar durante horas, y al darle a Publicar no había nada
     * que subir. Publicar sirve archivos, así que un proceso que escucha no
     * entra.
     *
     * Aquí se comprueba la señal que lo detecta: un proyecto que compila pero no
     * deja carpeta de salida. El aviso de que va a pasar es cosa del prompt del
     * agente, que ahora elige base local o externa según quién usa los datos.
     */
    const servidor = await createWorkspace("demo-publicar-servidor", { clean: true });
    await conScripts(servidor.dir, { dev: "node server.js", build: "echo sin front" });

    check("el build se detecta igual", (await detectBuild(servidor.dir))?.args.join(" ") === "run build");
    check("pero no hay carpeta que subir", buscarSalida(servidor.dir) === null);
  }

  console.log("\n10b. Quien publica escoge la plataforma, una vez");
  {
    const dos = ["vercel", "cloudflare"] as const;
    const elige = (url: string | null, pedida: unknown, disponibles: readonly ("vercel" | "cloudflare")[] = dos) =>
      JSON.stringify(plataformaParaPublicar(url, pedida, [...disponibles]));
    check("la primera vez, la que pidió", elige(null, "cloudflare") === '{"plataforma":"cloudflare"}', elige(null, "cloudflare"));
    check("sin pedir nada, la primera disponible", elige(null, undefined) === '{"plataforma":"vercel"}', elige(null, undefined));
    check("una que no está configurada se dice", elige(null, "vercel", ["cloudflare"]).includes("no está configurada"));
    check("algo que no es plataforma no cuenta", elige(null, "netlify") === '{"plataforma":"vercel"}', elige(null, "netlify"));
    // Republicar no cambia de plataforma: el link que ya se compartió seguiría
    // mostrando la versión vieja.
    check("ya en Vercel, sigue en Vercel aunque pida Cloudflare", elige("https://mi-app.vercel.app", "cloudflare") === '{"plataforma":"vercel"}');
    check("ya en Cloudflare, sigue en Cloudflare", elige("https://mi-app.pages.dev", "vercel") === '{"plataforma":"cloudflare"}');
    check("si ya no está configurada la suya, se dice", elige("https://mi-app.pages.dev", undefined, ["vercel"]).includes("ya no tiene configurada"));
    check("sin ninguna configurada, se dice", elige(null, undefined, []).includes("no tiene configurada la publicación"));
    check("la plataforma sale de la URL", plataformaDeUrl("https://x.vercel.app") === "vercel" && plataformaDeUrl("https://x.pages.dev") === "cloudflare");
  }

  console.log("\n11. Vercel: un solo comando, el token fuera de él, y la URL estable");
  {
    // Un proyecto que sí compila, con un runner que corre el build de verdad y
    // contesta el deploy a mano (subir de verdad necesitaría el token del dueño).
    const app = await createWorkspace("demo-publicar-vercel", { clean: true });
    await conScripts(app.dir, { dev: "vite", build: "mkdir -p dist && echo hola > dist/index.html" });
    const local = localRunner(app.dir);
    const llamadas: { command: string; env?: Record<string, string> }[] = [];
    let respuesta = { stdout: "", stderr: "", code: 0 };
    const runner: Runner = {
      isolated: false,
      exec(command, opts) {
        if (!command.includes("vercel@latest")) return local.exec(command, opts);
        llamadas.push({ command, env: opts.env });
        return Promise.resolve({ ...respuesta, timedOut: false });
      },
    };
    const TOKEN = "tok-secreto-123";

    // Así contesta `--json`: la URL de este deploy y sus alias.
    respuesta = {
      stdout: JSON.stringify({
        url: "https://mi-app-a1b2c3d-mi-equipo.vercel.app",
        alias: ["mi-app.vercel.app", "mi-app-mi-equipo.vercel.app"],
        readyState: "READY",
      }),
      stderr: "Vercel CLI 65.5.0\nDeploying...",
      code: 0,
    };
    const url = await publicarSala(app, runner, { plataforma: "vercel", token: TOKEN }, "Mi App");
    const cmd = llamadas[0]?.command ?? "";
    check("devuelve la estable, no la de este deploy", url === "https://mi-app.vercel.app", url);
    check("un solo comando a Vercel", llamadas.length === 1, String(llamadas.length));
    check("a producción y al proyecto con su nombre", cmd.includes("--prod") && cmd.includes('--project "mi-app"'), cmd);
    check("y lo crea si no existe", cmd.includes("--create-if-missing") && cmd.includes("--json"), cmd);
    check("sube la carpeta compilada", cmd.includes("dist"), cmd);
    check("el token NO va en el comando", !cmd.includes(TOKEN), cmd);
    check("va como VERCEL_TOKEN en sus variables", llamadas[0]?.env?.VERCEL_TOKEN === TOKEN);
    check("sin equipo no lleva --scope", !cmd.includes("--scope"), cmd);

    await publicarSala(app, runner, { plataforma: "vercel", token: TOKEN, equipo: "mi-equipo" }, "mi-app");
    check("con equipo lleva --scope", (llamadas[1]?.command ?? "").includes('--scope "mi-equipo"'), llamadas[1]?.command);

    // Un token malo: se dice qué pasa, sin el texto crudo del CLI.
    respuesta = { stdout: "", stderr: `Error: The specified token is not valid (${TOKEN}). Use \`vercel login\``, code: 1 };
    let error = "";
    try {
      await publicarSala(app, runner, { plataforma: "vercel", token: TOKEN }, "mi-app");
    } catch (err) {
      error = err instanceof NoSePudoPublicar ? err.message : `otro error: ${String(err)}`;
    }
    check("un token malo se explica", error.includes("credencial de publicación no sirve"), error);
    check("sin filtrar el token", !error.includes(TOKEN), error);

    // Un error que no se reconoce sale con su motivo, pero tampoco con el token.
    respuesta = { stdout: "", stderr: `Error: algo raro pasó con ${TOKEN}`, code: 1 };
    let raro = "";
    try {
      await publicarSala(app, runner, { plataforma: "vercel", token: TOKEN }, "mi-app");
    } catch (err) {
      raro = err instanceof NoSePudoPublicar ? err.message : `otro error: ${String(err)}`;
    }
    check("un error desconocido dice su motivo", raro.includes("algo raro"), raro);
    check("y tampoco lleva el token", !raro.includes(TOKEN), raro);
  }

  console.log("\n12. La URL de Vercel en los demás casos");
  {
    check(
      "si el nombre ya lo tiene otra cuenta, la estable con sufijo",
      sacarUrlVercel(JSON.stringify({ url: "https://mi-app-x9y8z7-yo.vercel.app", alias: ["mi-app-yo.vercel.app"] }), "mi-app") ===
        "https://mi-app-yo.vercel.app",
    );
    check(
      "sin JSON, se busca en el texto",
      sacarUrlVercel("Production: https://mi-app-a1b2c3-yo.vercel.app\nAliased: https://mi-app.vercel.app", "mi-app") ===
        "https://mi-app.vercel.app",
    );
    check("sin URL en la salida, no se inventa una", sacarUrlVercel("Error: algo", "mi-app") === null);
    check("un límite se explica", explicarVercel("Error: Rate limit exceeded for deployments").includes("límite"));
    check("la red también", explicarVercel("Error: getaddrinfo ENOTFOUND api.vercel.com").includes("no se pudo hablar"));
  }

  console.log(`\n${pass} pasaron, ${fail} fallaron\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\ndemo falló:", err);
  process.exit(1);
});
