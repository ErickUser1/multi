import {
  COOKIE_SESION,
  consumirState,
  cookieBorrada,
  cookieDeSesion,
  credencialDeGoogle,
  datosDelToken,
  nuevoState,
  tokenDeCookie,
  urlDeAutorizacion,
} from "../cuentas.js";
import { addMember, colorDe, type Room } from "../rooms.js";
import {
  guardarAvatar,
  rutaAvatar,
  mediaTypeDeAvatar,
  borrarAvatar,
  esAvatarPropio,
} from "../engine/avatares.js";

/**
 * Demo: las cuentas, que son OPCIONALES.
 * Uso: npm run demo:cuentas
 *
 * Lo que se prueba es la parte que decide: leer quién eres de lo que dice
 * Google, que un state no se pueda reusar, y sobre todo que sin cuenta todo
 * siga funcionando igual. El ida y vuelta con Google no se prueba aquí: haría
 * falta un navegador y credenciales de verdad.
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

/** Un id_token como el que devuelve Google, sin firmar (aquí no se verifica). */
function tokenDeMentira(payload: Record<string, unknown>): string {
  const cuerpo = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `cabecera.${cuerpo}.firma`;
}

/** Una sala de mentira, solo con lo que `addMember` toca. */
function salaVacia(): Room {
  return { members: new Map() } as unknown as Room;
}

/** Un PNG de un pixel, para no traer un archivo de prueba al repo. */
const pngDeUnPixel =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function main(): Promise<void> {
  console.log("\n=== cuentas (opcionales) ===\n");

  console.log("1. Sin credenciales configuradas no se ofrece entrar");
  {
    const antes = { id: process.env.GOOGLE_CLIENT_ID, secret: process.env.GOOGLE_CLIENT_SECRET };
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    check("sin nada, no hay login", credencialDeGoogle() === null);

    process.env.GOOGLE_CLIENT_ID = "solo-el-id";
    check("con una sola tampoco alcanza", credencialDeGoogle() === null);

    process.env.GOOGLE_CLIENT_SECRET = "y-el-secreto";
    check("con las dos ya sirve", credencialDeGoogle() !== null);

    if (antes.id) process.env.GOOGLE_CLIENT_ID = antes.id;
    else delete process.env.GOOGLE_CLIENT_ID;
    if (antes.secret) process.env.GOOGLE_CLIENT_SECRET = antes.secret;
    else delete process.env.GOOGLE_CLIENT_SECRET;
  }

  console.log("\n2. Quién eres, según lo que dijo Google");
  {
    const datos = datosDelToken(
      tokenDeMentira({
        sub: "1234567890",
        name: "Dan",
        email: "dan@ejemplo.com",
        picture: "https://lh3.googleusercontent.com/foto",
      }),
    );
    check("saca el identificador", datos?.sub === "1234567890", String(datos?.sub));
    check("el nombre", datos?.nombre === "Dan");
    check("el correo", datos?.correo === "dan@ejemplo.com");
    check("y la foto", datos?.foto === "https://lh3.googleusercontent.com/foto");
  }

  console.log("\n3. Una cuenta de Google sin foto entra igual");
  {
    // No todas las cuentas tienen foto, y eso no puede impedir entrar: se cae a
    // la inicial de siempre.
    const datos = datosDelToken(tokenDeMentira({ sub: "sin-foto", name: "Ana", email: "a@b.c" }));
    check("entra sin foto", datos !== null);
    check("y la foto queda vacía", datos?.foto === null);
  }

  console.log("\n4. Un token que no se puede leer no revienta");
  {
    check("basura", datosDelToken("no-es-un-token") === null);
    check("vacío", datosDelToken("") === null);
    check("sin la parte de en medio", datosDelToken("a..c") === null);
    // Sin `sub` no hay a quién atar la cuenta, así que no sirve aunque se lea.
    check("sin identificador", datosDelToken(tokenDeMentira({ name: "X" })) === null);
  }

  console.log("\n5. El state de la ida es de un solo uso");
  {
    const state = nuevoState();
    check("el primero vale", consumirState(state));
    // Si se pudiera reusar, alguien podría reenviar una vuelta de Google vieja.
    check("el segundo ya no", !consumirState(state));
    check("uno inventado tampoco", !consumirState("me-lo-acabo-de-inventar"));
    check("y sin state, no", !consumirState(undefined));
  }

  console.log("\n6. La URL a la que se manda a la persona");
  {
    const url = urlDeAutorizacion(
      { clientId: "mi-id", clientSecret: "mi-secreto" },
      "el-state",
      "https://multti.app/auth/google/callback",
    );
    check("va a Google", url.startsWith("https://accounts.google.com/o/oauth2/v2/auth?"));
    check("pide lo mínimo para saber quién es", url.includes("scope=openid+profile+email"));
    check("lleva el state", url.includes("state=el-state"));
    // El secreto solo viaja en el intercambio, de server a server. Si saliera
    // aquí quedaría en el historial del navegador de todo el mundo.
    check("y NUNCA el secreto", !url.includes("mi-secreto"));
  }

  console.log("\n7. La cookie de sesión no la puede leer el navegador");
  {
    const cookie = cookieDeSesion("un-token", true);
    // HttpOnly es lo que la pone fuera del alcance del código del preview, que
    // corre en el mismo origen y lo escribió un agente.
    check("es HttpOnly", cookie.includes("HttpOnly"));
    check("no viaja a sitios de terceros", cookie.includes("SameSite=Lax"));
    check("con https va marcada como segura", cookie.includes("Secure"));
    check("sin https, no (si no, en local no se guarda)", !cookieDeSesion("t", false).includes("Secure"));
    check("y al salir se vacía", cookieBorrada(true).includes("Max-Age=0"));
  }

  console.log("\n8. Leer la sesión de la cabecera de cookies");
  {
    check("sola", tokenDeCookie(`${COOKIE_SESION}=abc123`) === "abc123");
    check(
      "entre otras",
      tokenDeCookie(`otra=1; ${COOKIE_SESION}=abc123; multi_room=sala-1`) === "abc123",
    );
    check("sin cabecera", tokenDeCookie(undefined) === undefined);
    check("si no está", tokenDeCookie("otra=1; multi_room=sala-1") === undefined);
    // La cookie del proxy del preview empieza igual de parecido; no se vale
    // confundirlas.
    check("no se confunde con una parecida", tokenDeCookie("multi_sesion_otra=x") === undefined);
  }

  console.log("\n9. El color de alguien ya no cambia solo");
  {
    // El bug que arregla: antes el color se repartía por orden de llegada, así
    // que al reconectarte o cuando alguien se iba, cambiabas de color.
    check("el mismo siempre", colorDe("usuario-1") === colorDe("usuario-1"));
    // Con seis colores hay choques, y se aceptan: que TU color no cambie
    // importa más que ser distinto del de al lado, porque el nombre va pegado.
    // Lo que sí se comprueba es que reparta, no que devuelva siempre lo mismo.
    const repartidos = new Set(
      ["ana", "dan", "luis", "mar", "sol", "leo", "eva", "tom"].map(colorDe),
    );
    check("y reparte entre varios", repartidos.size >= 3, `${repartidos.size} colores distintos`);

    const sala = salaVacia();
    const primero = addMember(sala, "s1", "Dan");
    addMember(sala, "s2", "Ana");
    addMember(sala, "s3", "Luis");
    sala.members.delete("s2");
    const dePrimeroOtraVez = addMember(sala, "s4", "Dan");
    check(
      "no depende de cuántos haya en la sala",
      primero.color === dePrimeroOtraVez.color,
      `${primero.color} vs ${dePrimeroOtraVez.color}`,
    );
  }

  console.log("\n10. Sin cuenta se entra igual");
  {
    // El candado del requisito que manda sobre todo lo demás. Si esto se rompe
    // algún día, es que el login dejó de ser opcional.
    const sala = salaVacia();
    const anonimo = addMember(sala, "s1", "quien sea");
    check("hay miembro", anonimo.name === "quien sea");
    check("con su color", typeof anonimo.color === "string" && anonimo.color.startsWith("#"));
    check("sin cuenta", anonimo.usuarioId === undefined);
    check("y sin foto, que se cae a la inicial", anonimo.foto === null);

    const conCuenta = addMember(sala, "s2", "Dan", { id: "u-1", foto: "https://x/f.jpg" });
    check("y con cuenta se guarda de quién es", conCuenta.usuarioId === "u-1");
    check("con su foto", conCuenta.foto === "https://x/f.jpg");
  }

  console.log("\n11. Las fotos que sube la gente");
  {
    // El id cambia en cada subida, incluso de la misma persona. Eso es lo que
    // hace honesto el `immutable` con el que se sirven: si se reusara el id, la
    // foto vieja se quedaría pegada un año en el navegador de todos.
    const uno = await guardarAvatar({ mediaType: "image/png", data: pngDeUnPixel });
    const dos = await guardarAvatar({ mediaType: "image/png", data: pngDeUnPixel });
    check("dos subidas, dos ids", uno !== dos, `${uno} vs ${dos}`);
    check("y el tipo sale del id", mediaTypeDeAvatar(uno) === "image/png");

    await borrarAvatar(uno);
    await borrarAvatar(dos);
    check("borrar deja de encontrarla", (await rutaAvatar(uno)) === null);
    // Borrar algo que ya no está no puede reventar: pasa cada vez que alguien
    // cambia dos veces de foto seguidas.
    await borrarAvatar(uno);
    check("y borrar dos veces no truena", true);

    const grande = Buffer.alloc(600 * 1024).toString("base64");
    await guardarAvatar({ mediaType: "image/png", data: grande }).then(
      () => check("una foto enorme se rechaza", false, "la aceptó"),
      (err: Error) => check("una foto enorme se rechaza", err.message.includes("512KB"), err.message),
    );

    await guardarAvatar({ mediaType: "application/pdf", data: pngDeUnPixel }).then(
      () => check("un PDF no es una foto", false, "lo aceptó"),
      (err: Error) => check("un PDF no es una foto", err.message.includes("no soportado")),
    );
  }

  console.log("\n12. De quién es cada foto");
  {
    // Al cambiar de foto se borra la anterior, pero solo si era nuestra: las de
    // Google son una URL suya y no hay nada que borrar en nuestro disco.
    check("la de Google no se toca", !esAvatarPropio("https://lh3.googleusercontent.com/x"));
    check("la subida sí es nuestra", esAvatarPropio("/auth/foto/abc.png"));
    check("y sin foto no hay nada que borrar", !esAvatarPropio(null));
  }

  console.log(`\n${pass} pasaron, ${fail} fallaron\n`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();
