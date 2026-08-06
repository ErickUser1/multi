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

/** Los formatos que el server acepta (y que los modelos con visión entienden). */
const ACEPTADOS = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export interface AdjuntoPendiente {
  nombre: string;
  mediaType: string;
  /** base64 sin el prefijo `data:`. */
  data: string;
  /** Para la miniatura, antes de que el server lo guarde. */
  previewUrl: string;
}

export function esImagenAceptada(file: File): boolean {
  return ACEPTADOS.includes(file.type);
}

/**
 * Deja la imagen lista para mandar: encogida, en WebP, y en base64.
 *
 * Los GIF se dejan tal cual. Redibujarlos en un canvas se quedaría con el primer
 * fotograma, y quien manda un GIF lo manda por el movimiento.
 */
export async function prepararImagen(file: File): Promise<AdjuntoPendiente> {
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
  const escala = Math.min(1, LADO_MAXIMO / Math.max(bitmap.width, bitmap.height));
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

/** Las imágenes que vienen en un pegado o un arrastre. */
export function imagenesDe(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  return Array.from(dt.files).filter(esImagenAceptada);
}
