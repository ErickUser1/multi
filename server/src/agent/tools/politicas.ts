/**
 * Las políticas de RLS que dejan pasar a cualquiera.
 *
 * Una política `using (true)` o `with check (true)` es RLS prendido que no
 * protege nada: la llave pública va en el código de la app, así que con ella
 * cualquiera lee o escribe lo que la política deja. Pasó en una sala real: el
 * agente activó RLS en todas las tablas, como pide el prompt, y les puso
 * políticas `true` a todas. Las ubicaciones de menores quedaron legibles, y
 * los vínculos con sus familias, reescribibles por quien fuera.
 *
 * Se separan escritura y lectura porque no pesan igual. Que cualquiera ESCRIBA
 * casi nunca es lo que se quiere, y con el login anónimo de la base siempre hay
 * contra qué comparar (`auth.uid()`). Que cualquiera LEA sí puede ser lo
 * correcto: un menú, un catálogo, los resultados públicos de algo.
 */

export interface PoliticaAbierta {
  nombre: string;
  /** El comando que cubre: select, insert, update, delete o all. */
  para: string;
}

export interface PoliticasAbiertas {
  escritura: PoliticaAbierta[];
  lectura: PoliticaAbierta[];
}

/** Clasifica las políticas abiertas que trae un bloque de SQL. */
export function politicasAbiertas(sql: string): PoliticasAbiertas {
  const escritura: PoliticaAbierta[] = [];
  const lectura: PoliticaAbierta[] = [];

  for (const sentencia of sentencias(sql)) {
    if (!/^\s*(create|alter)\s+policy\b/i.test(sentencia)) continue;
    // `(true)` con o sin paréntesis de más: `using ((true))` también pasa.
    if (!/\b(using|with\s+check)\s*\(\s*\(?\s*true\s*\)?\s*\)/i.test(sentencia)) continue;

    const nombre = sentencia.match(/\bpolicy\s+("[^"]+"|[^\s]+)/i)?.[1]?.replace(/"/g, "") ?? "?";
    // Sin `for`, una política cubre todos los comandos.
    const para = (
      sentencia.match(/\bfor\s+(all|select|insert|update|delete)\b/i)?.[1] ?? "all"
    ).toLowerCase();

    (para === "select" ? lectura : escritura).push({ nombre, para });
  }
  return { escritura, lectura };
}

/**
 * Parte el SQL en sentencias por `;`, sin cortar dentro de comillas ni de
 * bloques `$tag$ ... $tag$`: el cuerpo de una función trae sus propios `;`, y
 * partirlo ahí haría que un pedazo pareciera una política suelta.
 */
function sentencias(sql: string): string[] {
  const salida: string[] = [];
  let actual = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];

    // Comentario de línea: se salta entero, puede traer `;` o comillas.
    if (c === "-" && sql[i + 1] === "-") {
      const fin = sql.indexOf("\n", i);
      i = fin === -1 ? sql.length : fin;
      continue;
    }
    if (c === "'" || c === '"') {
      const fin = sql.indexOf(c, i + 1);
      const hasta = fin === -1 ? sql.length : fin + 1;
      actual += sql.slice(i, hasta);
      i = hasta;
      continue;
    }
    if (c === "$") {
      const etiqueta = sql.slice(i).match(/^\$[A-Za-z_]*\$/)?.[0];
      if (etiqueta) {
        const fin = sql.indexOf(etiqueta, i + etiqueta.length);
        const hasta = fin === -1 ? sql.length : fin + etiqueta.length;
        actual += sql.slice(i, hasta);
        i = hasta;
        continue;
      }
    }
    if (c === ";") {
      salida.push(actual);
      actual = "";
    } else {
      actual += c;
    }
    i++;
  }
  if (actual.trim()) salida.push(actual);
  return salida;
}
