/**
 * La ruta de un `write_file`/`edit_file` sacada del JSON a medio llegar.
 *
 * Los argumentos de una herramienta llegan en pedazos. La ruta va primero y es
 * cortita, así que aparece mucho antes que el contenido: con ella la sala puede
 * decir "Escribiendo juego.js" desde el principio, y el aviso de "no cupo" puede
 * decir cuál archivo fue.
 */
export function rutaEnJsonParcial(json: string): string | undefined {
  const m = /"path"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(json);
  if (!m) return undefined;
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return undefined;
  }
}
