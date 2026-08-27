import { SERVER_URL } from "./socket";
import { salasVisitadas, type SalaVisitada } from "./historial-salas";

/**
 * La cuenta de quien está usando la Sala, si es que tiene una.
 *
 * TENER CUENTA ES OPCIONAL. Todo lo de aquí puede devolver "no hay nadie" y esa
 * es una respuesta normal, no un error: se entra a cualquier sala con el link y
 * ya. Esto sirve para que tus salas te sigan entre dispositivos y para que tu
 * cara y tu nombre sean los mismos en todas.
 *
 * La sesión vive en una cookie que este código NO puede leer (es HttpOnly), a
 * propósito: cuando Multi se corre entero desde un puerto, el preview de la sala
 * se sirve del mismo origen y ejecuta código que escribió un agente. Un token
 * en localStorage sería un token que ese código alcanza.
 */

export interface Usuario {
  id: string;
  nombre: string;
  correo: string;
  foto: string | null;
}

export interface EstadoDeCuenta {
  /** Si quien hospeda este Multi configuró el inicio de sesión. */
  configurado: boolean;
  usuario: Usuario | null;
}

/**
 * Quién soy, según el server.
 *
 * Si algo falla se responde "nadie, y sin login configurado". Que la Sala
 * arranque no puede depender de esto: sin cuenta funciona igual, así que un
 * fallo aquí no debe verse por ningún lado.
 */
export async function quienSoy(): Promise<EstadoDeCuenta> {
  try {
    const res = await fetch(`${SERVER_URL}/auth/yo`, { credentials: "include" });
    if (!res.ok) return { configurado: false, usuario: null };
    return (await res.json()) as EstadoDeCuenta;
  } catch {
    return { configurado: false, usuario: null };
  }
}

/**
 * Manda a la persona con Google.
 *
 * Es una navegación completa, no un fetch: el ida y vuelta de OAuth pasa por el
 * navegador. Se guarda antes a dónde volver, porque Google regresa a la raíz.
 */
export function entrarConGoogle(): void {
  try {
    sessionStorage.setItem("multi.volver-a", window.location.hash);
  } catch {
    // Sin sessionStorage se vuelve a la raíz y la persona navega otra vez. No
    // es motivo para no dejarla entrar.
  }
  window.location.href = `${SERVER_URL}/auth/google`;
}

/** A dónde estaba antes de irse con Google, si lo alcanzamos a guardar. */
export function volverDondeEstaba(): void {
  try {
    const destino = sessionStorage.getItem("multi.volver-a");
    sessionStorage.removeItem("multi.volver-a");
    if (destino && destino !== window.location.hash) window.location.hash = destino;
  } catch {
    // da igual
  }
}

export async function salir(): Promise<void> {
  await fetch(`${SERVER_URL}/auth/salir`, { method: "POST", credentials: "include" }).catch(
    () => {},
  );
}

/**
 * Sube al server las salas que estaban guardadas en este navegador y devuelve
 * la lista completa de la cuenta.
 *
 * Se llama en cada entrada y no solo al registrarse: si te haces cuenta en la
 * laptop y luego entras desde otra máquina donde tenías otras salas, esas
 * también suben. Sin esto, tener cuenta se sentiría como empezar de cero.
 */
export async function sincronizarSalas(): Promise<SalaVisitada[]> {
  const locales = salasVisitadas();
  try {
    const res = await fetch(`${SERVER_URL}/auth/salas`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ salas: locales }),
    });
    if (!res.ok) return locales;
    const { salas } = (await res.json()) as {
      salas: { roomId: string; visitadaEn: number; nombre?: string | null }[];
    };
    return salas.map((s) => ({ id: s.roomId, visitadaEn: s.visitadaEn, nombre: s.nombre ?? null }));
  } catch {
    // Sin server, lo de este navegador sigue sirviendo.
    return locales;
  }
}

/** Cambia tu nombre. El que pongas aquí pisa al que trajo Google. */
export async function cambiarNombre(nombre: string): Promise<Usuario | null> {
  try {
    const res = await fetch(`${SERVER_URL}/auth/perfil`, {
      method: "PATCH",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nombre }),
    });
    if (!res.ok) return null;
    const { usuario } = (await res.json()) as { usuario: Usuario };
    return usuario;
  } catch {
    return null;
  }
}

/**
 * Sube tu propia foto.
 *
 * Devuelve el usuario ya con la foto nueva, o el mensaje de por qué no se pudo.
 * El error se enseña: alguien que eligió una imagen y no ve nada pasar merece
 * saber si fue el tamaño o el formato.
 */
export async function cambiarFoto(
  mediaType: string,
  data: string,
): Promise<{ usuario: Usuario } | { error: string }> {
  try {
    const res = await fetch(`${SERVER_URL}/auth/perfil/foto`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mediaType, data }),
    });
    const cuerpo = (await res.json()) as { usuario?: Usuario; error?: string };
    if (!res.ok || !cuerpo.usuario) {
      return { error: cuerpo.error ?? "no se pudo guardar la foto" };
    }
    return { usuario: cuerpo.usuario };
  } catch {
    return { error: "no se pudo hablar con el server" };
  }
}

/**
 * La URL para pintar una foto de perfil.
 *
 * Las de Google vienen como URL completa; las que subió alguien vienen como una
 * ruta de este server. Se distinguen por el protocolo.
 */
export function urlDeFoto(foto: string | null | undefined): string | null {
  if (!foto) return null;
  return foto.startsWith("http") ? foto : `${SERVER_URL}${foto}`;
}
