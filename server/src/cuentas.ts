import { randomBytes, randomUUID } from "node:crypto";
import type { StoredUsuario } from "./storage/types.js";

/**
 * Las cuentas de Multi: entrar con Google, y nada más.
 *
 * TENER CUENTA ES OPCIONAL Y LO SEGUIRÁ SIENDO. Se entra a cualquier sala con
 * el link y ya, como siempre. Esto existe solo para quien quiere que sus salas
 * le sigan del celular a la compu, y que su cara y su nombre sean los mismos en
 * todas. Si algún camino de este archivo hace que alguien no pueda entrar,
 * está mal escrito.
 *
 * Se delega en Google en vez de guardar contraseñas: así Multi nunca almacena
 * el secreto de nadie, no hay que mandar correos de recuperación (que serían
 * otro servicio que dar de alta), y la foto de perfil llega gratis.
 *
 * Ojo con la asimetría contra `keys.ts`, porque es deliberada y opuesta: la API
 * key NUNCA va a disco, porque es un secreto de otro y guardarlo es una
 * responsabilidad que un proyecto que cualquiera hospeda no debe tener. La
 * sesión SÍ va a disco, porque su razón de existir es sobrevivir al reinicio.
 * Son dos decisiones contrarias por dos razones distintas; no se unifican.
 */

/** Cuánto dura una sesión. Larga a propósito: volver a entrar es fricción. */
const DURACION_MS = 90 * 24 * 60 * 60 * 1000;

export const COOKIE_SESION = "multi_sesion";

/** Lo que el front necesita saber de quien entró. */
export interface Usuario {
  id: string;
  nombre: string;
  correo: string;
  foto: string | null;
}

export interface CredencialGoogle {
  clientId: string;
  clientSecret: string;
}

/**
 * Las credenciales de Google del `.env`, o null si quien corre Multi no las puso.
 *
 * Se lee cada vez y no al arrancar para que agregarlas no obligue a reiniciar,
 * igual que la credencial de publicar. Sin ellas no hay botón de entrar y Multi
 * funciona igual que siempre: es una capacidad de menos, no un error.
 */
export function credencialDeGoogle(): CredencialGoogle | null {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

// ── El ida y vuelta con Google ──────────────────────────────────────────────

/**
 * Los `state` que están en vuelo.
 *
 * Son de un solo uso y sirven para que el callback pueda comprobar que la
 * vuelta corresponde a una ida que salió de aquí. Viven en memoria porque duran
 * lo que tarda alguien en apretar el botón de Google: si el server reinicia a
 * media autenticación, se vuelve a intentar y ya.
 */
const enVuelo = new Map<string, number>();
const VIDA_STATE_MS = 10 * 60 * 1000;

export function nuevoState(): string {
  limpiarStates();
  const state = randomBytes(16).toString("base64url");
  enVuelo.set(state, Date.now() + VIDA_STATE_MS);
  return state;
}

/** ¿Esta vuelta corresponde a una ida nuestra? Consume el state. */
export function consumirState(state: string | undefined): boolean {
  if (!state) return false;
  const expira = enVuelo.get(state);
  enVuelo.delete(state);
  return expira != null && expira > Date.now();
}

function limpiarStates(): void {
  const ahora = Date.now();
  for (const [state, expira] of enVuelo) {
    if (expira <= ahora) enVuelo.delete(state);
  }
}

/**
 * A dónde mandar a la persona para que Google le pregunte si nos deja entrar.
 *
 * `openid profile email` es el mínimo que da nombre, correo y foto. No se pide
 * nada más: cada permiso extra es una pantalla más intimidante y aquí solo hace
 * falta saber quién es.
 */
export function urlDeAutorizacion(cred: CredencialGoogle, state: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: cred.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid profile email",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

/**
 * Cambia el código que Google devolvió por el token que dice quién es la persona.
 *
 * Devuelve null si Google no lo acepta, sin distinguir por qué: lo que se puede
 * hacer al respecto es lo mismo en todos los casos (volver a intentar), y el
 * detalle se queda en el log del server.
 */
export async function intercambiarCodigo(
  cred: CredencialGoogle,
  code: string,
  redirectUri: string,
): Promise<string | null> {
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: cred.clientId,
        client_secret: cred.clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    if (!res.ok) {
      console.error(`[cuentas] Google rechazó el código: ${res.status}`);
      return null;
    }
    const datos = (await res.json()) as { id_token?: string };
    return datos.id_token ?? null;
  } catch (err) {
    console.error("[cuentas] no se pudo hablar con Google:", err);
    return null;
  }
}

export interface DatosDeGoogle {
  sub: string;
  nombre: string;
  correo: string;
  foto: string | null;
}

/**
 * Quién es, según el token que dio Google.
 *
 * NO se verifica la firma, y es correcto: este token no llegó por el navegador
 * de nadie, lo pedimos nosotros por HTTPS directamente a Google. El TLS ya
 * garantiza el origen, así que validar el JWT contra las llaves públicas sería
 * comprobar dos veces lo mismo.
 *
 * Ojo con `sub`: ese es el identificador de la cuenta, y es el que no cambia
 * aunque la persona cambie de correo. La cuenta se ata a eso, nunca al correo.
 */
export function datosDelToken(idToken: string): DatosDeGoogle | null {
  try {
    const payload = idToken.split(".")[1];
    if (!payload) return null;
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    const sub = typeof json.sub === "string" ? json.sub : "";
    if (!sub) return null;
    return {
      sub,
      nombre: typeof json.name === "string" ? json.name : "sin nombre",
      correo: typeof json.email === "string" ? json.email : "",
      foto: typeof json.picture === "string" ? json.picture : null,
    };
  } catch {
    // Un token que no se puede leer es un token que no sirve. Quien llama
    // decide qué hacer; aquí no hay nada que rescatar.
    return null;
  }
}

// ── Sesiones ────────────────────────────────────────────────────────────────

export function nuevoTokenDeSesion(): string {
  return randomBytes(32).toString("base64url");
}

export function nuevoIdDeUsuario(): string {
  return randomUUID();
}

export function cuandoExpira(): number {
  return Date.now() + DURACION_MS;
}

/**
 * La cabecera que deja la sesión en el navegador.
 *
 * `HttpOnly` no es opcional aquí: cuando Multi se corre con `npm start`, el
 * preview de la sala se sirve desde el MISMO origen, y ese preview ejecuta
 * código que escribió un agente. Un token que el JavaScript de la página pueda
 * leer sería un token que ese código puede leer. Así no lo alcanza.
 *
 * `SameSite=Lax` deja pasar la vuelta de Google (es una navegación de primer
 * nivel) y bloquea peticiones cruzadas de terceros.
 */
export function cookieDeSesion(token: string, seguro: boolean): string {
  const partes = [
    `${COOKIE_SESION}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(DURACION_MS / 1000)}`,
  ];
  if (seguro) partes.push("Secure");
  return partes.join("; ");
}

export function cookieBorrada(seguro: boolean): string {
  const partes = [`${COOKIE_SESION}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (seguro) partes.push("Secure");
  return partes.join("; ");
}

/**
 * El token de sesión que venga en la cabecera de cookies.
 *
 * Se parsea a mano en vez de meter una dependencia: es una cabecera con pares
 * separados por punto y coma. La usa tanto el HTTP como el socket, que lee la
 * misma cookie del handshake.
 */
export function tokenDeCookie(cabecera: string | undefined): string | undefined {
  if (!cabecera) return undefined;
  for (const parte of cabecera.split(";")) {
    const igual = parte.indexOf("=");
    if (igual <= 0) continue;
    if (parte.slice(0, igual).trim() !== COOKIE_SESION) continue;
    const valor = parte.slice(igual + 1).trim();
    return valor || undefined;
  }
  return undefined;
}

/** Lo que se le manda al front. Nunca el token ni el `google_sub`. */
export function aUsuarioPublico(u: StoredUsuario): Usuario {
  return { id: u.id, nombre: u.nombre, correo: u.correo, foto: u.foto ?? null };
}
