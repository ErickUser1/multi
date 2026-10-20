import { detectBuild, buscarSalida } from "./preview.js";
import type { Runner } from "./runner.js";
import type { Workspace } from "./workspace.js";

/**
 * Publicar la app de una sala en internet.
 *
 * El último tramo del recorrido: la sala construye algo, lo ve en el preview, y
 * con esto queda en una URL que se le puede pasar a alguien que no entró nunca.
 *
 * Va a Cloudflare Pages por `wrangler`, que sube una carpeta de archivos y no
 * pregunta más. La credencial es de QUIEN CORRE MULTI, no de quien publica: es
 * la misma decisión que la API key de respaldo, y por la misma razón — pedirle
 * a alguien que abra una cuenta en otro servicio para ver su propia app es la
 * fricción que este producto existe para quitar.
 *
 * Lo que NO hace: sacar de aquí una app con servidor. Pages sirve archivos, así
 * que una API en Go o un Django con base de datos no caben. Eso se dice cuando
 * pasa, en vez de fallar con un error de wrangler que nadie entiende.
 */

/** Por dónde va la publicación. Es lo que ve la sala mientras espera. */
export type EtapaDeploy = "compilando" | "subiendo";

export interface Credencial {
  token: string;
  accountId: string;
}

export class NoSePudoPublicar extends Error {}

/**
 * La credencial como variables del comando.
 *
 * Por aquí y no interpolada en el comando: así no queda a la vista en la lista
 * de procesos de adentro del contenedor.
 */
function variablesDe(cred: Credencial): Record<string, string> {
  return {
    CLOUDFLARE_API_TOKEN: cred.token,
    CLOUDFLARE_ACCOUNT_ID: cred.accountId,
  };
}

/**
 * Compila el proyecto y lo sube. Devuelve la URL pública.
 *
 * `onEtapa` avisa por dónde va: un build de verdad tarda minutos, y sin eso la
 * sala mira un botón quieto sin saber si sigue vivo.
 */
export async function publicarSala(
  workspace: Workspace,
  runner: Runner,
  cred: Credencial,
  /**
   * El nombre del proyecto en Cloudflare, que es la dirección de la app.
   *
   * Siempre el mismo para la misma sala: así republicar pisa lo anterior y el
   * link que alguien ya compartió sigue sirviendo, en vez de acumular una URL
   * nueva cada vez. Lo decide quien llama (ver /rooms/:id/publicar).
   */
  nombre: string,
  onEtapa?: (etapa: EtapaDeploy) => void,
): Promise<string> {
  // Se filtra aunque ya venga limpio: acaba en un dominio y en un comando.
  const proyecto = nombreDeApp(nombre);
  if (!proyecto) throw new NoSePudoPublicar("ese nombre no sirve para una dirección web");

  const build = await detectBuild(workspace.dir);
  if (!build) {
    throw new NoSePudoPublicar(
      "este proyecto no declara cómo compilarse, así que no hay nada que subir",
    );
  }

  // Si el proyecto quedó en una subcarpeta, todo ocurre ahí dentro. Mismo
  // cálculo que hace el arranque del dev server.
  const sub =
    build.cwd && build.cwd !== workspace.dir
      ? build.cwd.slice(workspace.dir.length).replace(/^[/\\]/, "")
      : "";
  const cd = sub ? `cd ${JSON.stringify(sub)} && ` : "";

  onEtapa?.("compilando");
  const compilado = await runner.exec(cd + [build.command, ...build.args].join(" "), {
    timeoutMs: 600_000,
    maxOutput: 4000,
  });
  if (compilado.code !== 0) {
    throw new NoSePudoPublicar(
      compilado.timedOut
        ? "el proyecto tardó demasiado en compilar"
        : `el proyecto no compila: ${motivoDeFallo(compilado.stderr || compilado.stdout)}`,
    );
  }

  const salida = buscarSalida(build.cwd ?? workspace.dir);
  if (!salida) {
    throw new NoSePudoPublicar(
      "el proyecto compiló pero no dejó archivos para servir. Publicar sirve para " +
        "apps que se ven en el navegador; una que necesita servidor propio no cabe aquí",
    );
  }

  onEtapa?.("subiendo");

  /**
   * Crear el proyecto antes de subir, porque `deploy` no lo crea solo: la
   * primera publicación de una sala fallaba con "The Pages project does not
   * exist".
   *
   * Se intenta siempre y se ignora el resultado: si ya existe, el comando falla
   * y da igual — lo que importa es que exista cuando `deploy` llegue. Preguntar
   * primero si está sería una llamada más para el mismo desenlace.
   */
  await runner
    .exec(
      `${cd}npx --yes wrangler@latest pages project create ${JSON.stringify(proyecto)} ` +
        `--production-branch=main`,
      { timeoutMs: 120_000, maxOutput: 2000, env: variablesDe(cred) },
    )
    .catch(() => null);

  /**
   * `--branch=main` no es opcional: sin él wrangler sube a una rama de preview,
   * y entonces la URL estable del proyecto queda vacía ("Nothing is here yet")
   * mientras el contenido solo vive en una URL con prefijo que cambia en cada
   * publicación. Pasó en el primer deploy que funcionó.
   *
   * Tiene que coincidir con la `--production-branch` de arriba.
   */
  const subido = await runner.exec(
    `${cd}npx --yes wrangler@latest pages deploy ${JSON.stringify(salida)} ` +
      `--project-name=${JSON.stringify(proyecto)} --branch=main --commit-dirty=true`,
    {
      timeoutMs: 600_000,
      maxOutput: 8000,
      env: variablesDe(cred),
    },
  );

  const url = sacarUrl(subido.stdout + "\n" + subido.stderr, proyecto);
  if (subido.code !== 0 || !url) {
    // El texto crudo de wrangler NO se propaga: lleva el account id y, cuando
    // falla la autenticación, fragmentos de lo que se le pasó. Se traduce a lo
    // que la persona puede hacer al respecto.
    throw new NoSePudoPublicar(explicarWrangler(subido.stderr + subido.stdout));
  }
  return url;
}

/**
 * La URL de la app, que es la ESTABLE del proyecto.
 *
 * Wrangler imprime la de este deploy en concreto, con un prefijo que cambia cada
 * vez (`3217c505.la-sala.pages.dev`). Esa sirve para ver lo que se acaba de
 * subir, pero es la equivocada para compartir: el link que le pasaste a alguien
 * se quedaría mostrando la versión de ese momento, y republicar no lo
 * actualizaría.
 *
 * La estable (`la-sala.pages.dev`) siempre apunta a lo último, que es lo que se
 * quiere de un link que se comparte. Se confirma contra la salida en vez de
 * darla por hecha: si wrangler no menciona el proyecto, algo salió distinto de
 * lo esperado y es mejor no inventar una URL que quizá no carga.
 */
export function sacarUrl(salida: string, proyecto: string): string | null {
  const urls = salida.match(/https:\/\/[a-z0-9.-]*\.pages\.dev[^\s]*/gi);
  if (!urls) return null;
  for (const url of urls) {
    const etiquetas = new URL(url).hostname.split(".");
    // `hash.sub.pages.dev` o `sub.pages.dev`.
    const sub = etiquetas.length === 4 ? etiquetas[1]! : etiquetas[0]!;
    // Los subdominios de pages.dev son de todo Cloudflare, no de esta cuenta:
    // si el nombre ya lo tiene otra cuenta, el proyecto queda en
    // `nombre-abc.pages.dev`. Esa es la estable, aunque no sea la que se pidió.
    if (sub === proyecto || sub.startsWith(`${proyecto}-`)) return `https://${sub}.pages.dev`;
  }
  return urls[0]!;
}

/**
 * El nombre de una app para su dirección: `nombre.pages.dev`.
 *
 * Lo escribe la persona ("Página tipo Uber!!"), así que se pasa a lo que acepta
 * un subdominio: minúsculas sin acentos, guiones en lugar de lo demás, y el tope
 * de 58 que pone Cloudflare. Acaba en un dominio público y en un argumento de
 * línea de comandos, así que se filtra siempre, venga de donde venga.
 * `null` si no quedó nada.
 */
export function nombreDeApp(texto: string): string | null {
  const limpio = texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 58)
    .replace(/-+$/g, "");
  return limpio || null;
}

/**
 * El motivo de un comando que falló.
 *
 * Se busca la última línea CON CONTENIDO, saltándose las decorativas: wrangler
 * cierra su salida con una barra de guiones y una nota de dónde dejó el log, así
 * que quedarse con la última literal daba un mensaje que solo decía
 * "────────────────────". Pasó de verdad, y dejó sin ver el error real.
 */
export function motivoDeFallo(texto: string): string {
  const lineas = texto
    .trim()
    .split("\n")
    .map((l) => l.trim())
    // Fuera lo que no dice nada: separadores, banderas de versión, la ruta del
    // log, y los códigos de color que wrangler mete en cada línea.
    .map((l) => l.replace(/\[[0-9;]*m/g, ""))
    .filter((l) => l && !/^[─━=*-]+$/.test(l) && !/^[🪵⛅]/u.test(l));

  // Si hay una línea marcada como error, esa es la buena: suele estar antes de
  // la explicación larga, no al final.
  const error = lineas.find((l) => /^(✘|✖|x)?\s*\[?ERROR\]?/i.test(l));
  return (error ?? lineas[lineas.length - 1] ?? "sin detalle").slice(0, 200);
}

/**
 * Traduce el error de wrangler a algo accionable.
 *
 * Mismo criterio que `explicarFalla` para los proveedores de modelo: el volcado
 * crudo no le dice a nadie si el problema es la cuenta, el token o el proyecto,
 * y sin saberlo no puede hacer nada. El detalle técnico se queda en el log del
 * server.
 */
function explicarWrangler(texto: string): string {
  if (/authentication|unauthorized|10000|invalid.*token/i.test(texto)) {
    return "la credencial de publicación no sirve. Quien administra este Multti tiene que revisarla";
  }
  if (/account.*not found|10001/i.test(texto)) {
    return "la cuenta configurada para publicar no existe o el token no la alcanza";
  }
  if (/limit|quota|too many/i.test(texto)) {
    return "la cuenta de publicación llegó a su límite de proyectos";
  }
  if (/ENOTFOUND|ETIMEDOUT|network|fetch failed/i.test(texto)) {
    return "no se pudo hablar con el servicio de publicación. Vuelve a intentar";
  }
  return `no se pudo publicar — ${motivoDeFallo(texto)}`;
}

/**
 * La credencial del `.env` del server, o null si quien lo corre no la configuró.
 *
 * Se lee cada vez y no al arrancar para que agregarla no obligue a reiniciar.
 */
export function credencialDeDeploy(): Credencial | null {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !accountId) return null;
  return { token, accountId };
}
