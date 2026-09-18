import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/**
 * Cifrado de lo que Multi SÍ guarda a disco.
 *
 * Este módulo existe para una excepción, y conviene nombrarla porque contradice
 * a `keys.ts`: ahí la regla es que la key de alguien jamás toca el disco, porque
 * guardar el secreto de otro es una responsabilidad que un proyecto que
 * cualquiera hospeda no debe tomar.
 *
 * Un token de OAuth es otra cosa. No es un secreto que la persona teclea cada
 * vez: es un permiso que concedió UNA vez, apretando un botón, y que tiene que
 * seguir valiendo mañana cuando vuelva. Si no sobrevive al reinicio, la
 * concesión no sirvió de nada y hay que pedirla otra vez. Igual que la sesión,
 * que también va a disco por la misma razón.
 *
 * Así que se guarda, y por eso se cifra: la llave vive en el `.env` del server y
 * los datos en SQLite, de modo que quien se lleve el archivo de la base no se
 * lleva nada legible. No protege contra alguien que ya entró al server (ahí
 * tiene las dos cosas), y eso es cierto de cualquier sistema que guarde
 * credenciales. Protege del caso realista: una copia de la base que se filtra.
 *
 * AES-256-GCM y no CBC porque GCM viene autenticado: si alguien edita el texto
 * cifrado a mano en la base, descifrar FALLA en vez de devolver basura que el
 * resto del código trataría como un token válido.
 */

/**
 * La llave maestra del `.env`, o null si quien corre Multi no la puso.
 *
 * Se lee en cada llamada y no al arrancar, igual que la credencial de Google y
 * la de Cloudflare: agregarla no debe obligar a reiniciar el server.
 */
function secreto(): string | null {
  const v = process.env.MULTI_LLAVE;
  return v && v.trim().length > 0 ? v.trim() : null;
}

/** ¿Este Multi puede guardar secretos? Sin llave, las capacidades que lo necesitan no se ofrecen. */
export function hayLlave(): boolean {
  return secreto() !== null;
}

export class SinLlave extends Error {
  constructor() {
    super("este Multi no tiene MULTI_LLAVE configurada, así que no puede guardar secretos");
  }
}

/**
 * La llave de 32 bytes, derivada de lo que haya en el `.env`.
 *
 * Con scrypt y no usando el texto tal cual porque nadie escribe 32 bytes de
 * entropía a mano: lo que va a haber ahí es una frase, y derivarla es lo que la
 * convierte en una llave de verdad.
 *
 * La sal es fija a propósito. Una aleatoria obligaría a guardarla junto a cada
 * valor, y aquí no aporta: su trabajo es que dos servers con la misma frase no
 * compartan llave, y para eso ya está el que la frase sea distinta. Lo que sí
 * hace falta por valor es el IV, y ese sí es aleatorio.
 *
 * Se memoiza porque scrypt es lento a propósito (ese es su punto) y esto corre
 * en cada lectura de la tabla.
 */
let derivada: { de: string; llave: Buffer } | null = null;
function llave(): Buffer {
  const s = secreto();
  if (!s) throw new SinLlave();
  if (derivada?.de === s) return derivada.llave;
  const llaveNueva = scryptSync(s, "multi.cripto.v1", 32);
  derivada = { de: s, llave: llaveNueva };
  return llaveNueva;
}

/** Separador de las tres partes. Los dos primeros campos son base64url, que nunca trae puntos. */
const SEP = ".";

/**
 * Cifra un texto. El resultado es `iv.tag.datos`, todo en base64url, listo para
 * meterse en una columna TEXT.
 */
export function cifrar(texto: string): string {
  const iv = randomBytes(12); // 12 bytes es el tamaño que GCM espera
  const cifrador = createCipheriv("aes-256-gcm", llave(), iv);
  const datos = Buffer.concat([cifrador.update(texto, "utf8"), cifrador.final()]);
  const tag = cifrador.getAuthTag();
  return [iv.toString("base64url"), tag.toString("base64url"), datos.toString("base64url")].join(
    SEP,
  );
}

/**
 * Descifra lo que produjo `cifrar`. Devuelve null si el texto viene mal formado,
 * si lo tocaron, o si la llave de ahora no es la que lo cifró.
 *
 * Null y no una excepción porque el caso que importa es recuperable: si alguien
 * cambió `MULTI_LLAVE`, lo que había guardado deja de leerse, y la respuesta
 * correcta es tratar esa conexión como no existente y pedirla otra vez. Tirar
 * el server por eso sería peor.
 */
export function descifrar(texto: string): string | null {
  const partes = texto.split(SEP);
  if (partes.length !== 3) return null;
  try {
    const [iv, tag, datos] = partes.map((p) => Buffer.from(p, "base64url"));
    const descifrador = createDecipheriv("aes-256-gcm", llave(), iv);
    descifrador.setAuthTag(tag);
    return Buffer.concat([descifrador.update(datos), descifrador.final()]).toString("utf8");
  } catch {
    // Texto manipulado, llave distinta o base64 inválido. Los tres se tratan igual.
    return null;
  }
}
