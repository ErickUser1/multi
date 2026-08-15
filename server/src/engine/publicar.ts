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
 * Compila el proyecto y lo sube. Devuelve la URL pública.
 *
 * `onEtapa` avisa por dónde va: un build de verdad tarda minutos, y sin eso la
 * sala mira un botón quieto sin saber si sigue vivo.
 */
export async function publicarSala(
  workspace: Workspace,
  runner: Runner,
  cred: Credencial,
  onEtapa?: (etapa: EtapaDeploy) => void,
): Promise<string> {
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
        : `el proyecto no compila: ${ultimaLinea(compilado.stderr || compilado.stdout)}`,
    );
  }

  const salida = buscarSalida(build.cwd ?? workspace.dir);
  if (!salida) {
    throw new NoSePudoPublicar(
      "el proyecto compiló pero no dejó archivos para servir. Publicar sirve para " +
        "apps que se ven en el navegador; una que necesita servidor propio no cabe aquí",
    );
  }

  /**
   * El nombre del proyecto en Cloudflare es el id de la sala.
   *
   * Así republicar pisa lo anterior y el link que alguien ya compartió sigue
   * sirviendo, en vez de acumular una URL nueva por cada vez que se publica.
   *
   * Se filtra aunque los ids ya vengan limpios: acaba en un dominio público y en
   * un argumento de línea de comandos.
   */
  const proyecto = workspace.roomId.replace(/[^a-z0-9-]/gi, "").toLowerCase().slice(0, 58);

  onEtapa?.("subiendo");
  const subido = await runner.exec(
    `${cd}npx --yes wrangler@latest pages deploy ${JSON.stringify(salida)} ` +
      `--project-name=${JSON.stringify(proyecto)} --commit-dirty=true`,
    {
      timeoutMs: 600_000,
      maxOutput: 8000,
      // Por aquí y no interpolado en el comando: así no queda a la vista en la
      // lista de procesos de adentro.
      env: {
        CLOUDFLARE_API_TOKEN: cred.token,
        CLOUDFLARE_ACCOUNT_ID: cred.accountId,
      },
    },
  );

  const url = sacarUrl(subido.stdout + "\n" + subido.stderr);
  if (subido.code !== 0 || !url) {
    // El texto crudo de wrangler NO se propaga: lleva el account id y, cuando
    // falla la autenticación, fragmentos de lo que se le pasó. Se traduce a lo
    // que la persona puede hacer al respecto.
    throw new NoSePudoPublicar(explicarWrangler(subido.stderr + subido.stdout));
  }
  return url;
}

/**
 * La URL que wrangler imprime al terminar.
 *
 * Se busca en la salida en vez de armarla como `${proyecto}.pages.dev` porque el
 * primer deploy de un proyecto responde con una URL por rama, y adivinarla daría
 * un link que no carga.
 */
function sacarUrl(salida: string): string | null {
  const m = salida.match(/https:\/\/[a-z0-9.-]*\.pages\.dev[^\s]*/i);
  return m ? m[0] : null;
}

/** Lo último que dijo un comando que falló, que es donde suele estar el motivo. */
function ultimaLinea(texto: string): string {
  const lineas = texto.trim().split("\n").filter(Boolean);
  return (lineas[lineas.length - 1] ?? "sin detalle").slice(0, 150);
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
    return "la credencial de publicación no sirve. Quien administra este Multi tiene que revisarla";
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
  return `no se pudo publicar — ${ultimaLinea(texto)}`;
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
