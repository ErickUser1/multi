/**
 * Las imágenes se encogen ANTES de salir del navegador.
 *
 * Dos razones, y la segunda importa más de lo que parece. La primera es el peso:
 * una captura de pantalla son varios megas y el socket tiene un tope. La segunda
 * es el costo: una imagen cuesta tokens según sus dimensiones, y en Multi paga
 * cada quien con su propia key. Mandar una captura de 4K en vez de reducirla
 * significa que quien invoque al agente paga tres veces más por la misma imagen.
 *
 * El límite es 1568px de lado mayor. Sale de la documentación de Anthropic: es la
 * resolución máxima que los modelos de gama estándar procesan sin reescalar por su
 * cuenta. Mandar algo más grande no mejora nada, solo cuesta.
 *
 * Se hace con canvas, que ya viene en el navegador. Meter una librería de imágenes
 * en el server sería una dependencia nativa para algo que aquí sale gratis.
 */

/** El lado mayor, en píxeles, con el que se manda una imagen. */
const LADO_MAXIMO = 1568;

/** Calidad del WebP. 0.85 es donde deja de notarse la diferencia. */
const CALIDAD = 0.85;

/** Las imágenes que el server acepta (y que los modelos con visión entienden). */
export const IMAGENES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/** Todo lo que se puede adjuntar. El PDF lo lee el modelo sin convertirlo. */
export const ACEPTADOS = [...IMAGENES, "application/pdf"];

/**
 * Un archivo que va a salir con el próximo mensaje.
 *
 * El contenido ya NO viaja aquí: se sube aparte por HTTP y lo que queda es el
 * `id` que devolvió el server. Mientras sube, `id` es null y `subiendo` marca el
 * progreso; el botón de enviar espera a que todos terminen, porque mandar un id
 * que aún no existe da un mensaje sin su archivo.
 */
export interface AdjuntoPendiente {
  /** Local, para poder quitarlo de la lista antes de que el server responda. */
  clave: string;
  nombre: string;
  mediaType: string;
  /** El id del server, o null mientras sube. */
  id: string | null;
  /** De 0 a 100 mientras sube, null cuando ya terminó. */
  subiendo: number | null;
  /** Miniatura local, solo para imágenes. */
  previewUrl?: string;
}

export function esImagenAceptada(file: File): boolean {
  return ACEPTADOS.includes(file.type);
}

export function esPdf(file: { mediaType: string } | File): boolean {
  const tipo = "mediaType" in file ? file.mediaType : file.type;
  return tipo === "application/pdf";
}

/**
 * Deja la imagen lista para mandar: encogida, en WebP, y en base64.
 *
 * Los GIF se dejan tal cual. Redibujarlos en un canvas se quedaría con el primer
 * fotograma, y quien manda un GIF lo manda por el movimiento.
 */
/**
 * Sube un archivo a la sala y devuelve su id.
 *
 * Con XMLHttpRequest y no `fetch` porque fetch NO da eventos de progreso de
 * subida, y con un PDF de varios megas un spinner mudo se siente roto.
 *
 * Va por HTTP y no por el socket: multipart manda bytes crudos, mientras que
 * base64 dentro de un mensaje crece un tercio y el server tendría que cargarlo
 * entero en memoria antes de poder escribirlo.
 */
export function subirAdjunto(
  serverUrl: string,
  roomId: string,
  file: File,
  onProgreso: (pct: number) => void,
): Promise<{ id: string; nombre: string; mediaType: string }> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("archivo", file, file.name);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${serverUrl}/rooms/${roomId}/adjuntos`);
    xhr.withCredentials = true;

    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) onProgreso(Math.round((e.loaded / e.total) * 100));
    });

    xhr.addEventListener("load", () => {
      try {
        const cuerpo = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(cuerpo);
        else reject(new Error(cuerpo.error ?? "no se pudo subir el archivo"));
      } catch {
        reject(new Error("no se pudo subir el archivo"));
      }
    });
    xhr.addEventListener("error", () => reject(new Error("se cortó la subida")));
    xhr.addEventListener("abort", () => reject(new Error("se canceló la subida")));

    xhr.send(form);
  });
}

/** Una imagen ya reducida, en base64. La usa el panel de perfil. */
export interface ImagenLista {
  nombre: string;
  mediaType: string;
  /** base64 sin el prefijo `data:`. */
  data: string;
  previewUrl: string;
}

export async function prepararImagen(
  file: File,
  /**
   * A cuánto reducir el lado más largo. El default sirve para el chat, donde
   * el modelo va a mirar la imagen. Una foto de perfil se pinta a 34 píxeles,
   * así que ahí se pide mucho menos y baja de megas a kilobytes.
   */
  opts: { lado?: number } = {},
): Promise<ImagenLista> {
  if (!esImagenAceptada(file)) {
    throw new Error(`no puedo con archivos ${file.type || "de ese tipo"}`);
  }

  if (file.type === "image/gif") {
    const data = await comoBase64(file);
    return {
      nombre: file.name || "imagen.gif",
      mediaType: "image/gif",
      data,
      previewUrl: `data:image/gif;base64,${data}`,
    };
  }

  const bitmap = await createImageBitmap(file);
  const lado = opts.lado ?? LADO_MAXIMO;
  const escala = Math.min(1, lado / Math.max(bitmap.width, bitmap.height));
  const ancho = Math.round(bitmap.width * escala);
  const alto = Math.round(bitmap.height * escala);

  const canvas = document.createElement("canvas");
  canvas.width = ancho;
  canvas.height = alto;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("este navegador no me deja procesar la imagen");
  ctx.drawImage(bitmap, 0, 0, ancho, alto);
  bitmap.close();

  const dataUrl = canvas.toDataURL("image/webp", CALIDAD);
  return {
    nombre: file.name || "imagen.png",
    mediaType: "image/webp",
    data: dataUrl.slice(dataUrl.indexOf(",") + 1),
    previewUrl: dataUrl,
  };
}

/**
 * Deja un archivo del chat listo para subir.
 *
 * Las imágenes se reducen antes (una foto de celular son varios megas para
 * mirarse a 300 píxeles); los PDF se mandan tal cual, porque no se pueden
 * reducir sin perder lo que traen.
 */
export async function prepararParaSubir(file: File): Promise<File> {
  if (!esImagenAceptada(file)) {
    throw new Error(`no puedo con archivos ${file.type || "de ese tipo"}`);
  }
  if (esPdf(file) || file.type === "image/gif") return file;

  const lista = await prepararImagen(file);
  const binario = Uint8Array.from(atob(lista.data), (c) => c.charCodeAt(0));
  return new File([binario], lista.nombre, { type: lista.mediaType });
}

function comoBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const r = String(reader.result);
      resolve(r.slice(r.indexOf(",") + 1));
    };
    reader.onerror = () => reject(new Error("no se pudo leer el archivo"));
    reader.readAsDataURL(file);
  });
}

/** Los archivos aceptados que vienen en un pegado o un arrastre. */
export function imagenesDe(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  return Array.from(dt.files).filter(esImagenAceptada);
}
