import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { existsSync } from "node:fs";

/**
 * Qué está pasando en Multi: quién entra, quién construye, quién vuelve.
 * Uso: npm run uso            (los últimos 7 días)
 *      npm run uso -- 30      (los últimos 30)
 *
 * Sale de la misma BD que usa el server, en solo lectura. No es analítica web:
 * las visitas no dicen si Multi sirve. Lo que importa es si la gente le pide
 * cosas a un agente y si vuelve al día siguiente, y eso ya está guardado.
 *
 * Lo que NO se puede saber desde aquí: cuánta gente abrió el link y se fue sin
 * crear nada. Para ese lado del embudo haría falta analítica de verdad.
 */

const DB_PATH = process.env.MULTI_DB ?? join(process.cwd(), "..", "workspaces", "multi.db");
const DIAS = Number(process.argv[2] ?? 7);
const DESDE = Date.now() - DIAS * 24 * 60 * 60 * 1000;
const DIA = 24 * 60 * 60 * 1000;

/**
 * Abre la base para leerla, por el camino que funcione.
 *
 * Primero en solo lectura normal, que es lo correcto: SQLite aplica el WAL y se
 * ve TODO, incluido lo que el server acaba de escribir. Importa más de lo que
 * parece, porque en una base recién creada las tablas viven solo en el WAL
 * hasta el primer checkpoint: leer sin él da "no such table: rooms" sobre una
 * base que está perfectamente sana. Pasó en el servidor el primer día.
 *
 * Si eso falla, se reintenta con `immutable=1`, que lee el .db sin tocar el WAL
 * ni tomar bloqueos. Hace falta sobre el disco de Windows montado en WSL, donde
 * la memoria compartida del WAL no funciona y cualquier apertura normal muere
 * con "disk I/O error". Ahí se ve todo lo consolidado y pueden faltar los
 * últimos minutos, que para contar uso da igual.
 *
 * En ese orden y no al revés: el respaldo miente un poco, así que solo se usa
 * cuando el camino honesto no está disponible.
 */
function abrirParaLeer(): DatabaseSync {
  try {
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    // Forzar una lectura de verdad: abrir puede pasar y fallar al consultar.
    db.prepare(`SELECT COUNT(*) FROM rooms`).get();
    return db;
  } catch {
    // `enableURI` existe en node:sqlite pero todavía no en sus tipos (el módulo
    // sigue marcado como experimental): el cast es contra ese desfase.
    return new DatabaseSync(`file:${DB_PATH}?immutable=1`, {
      readOnly: true,
      enableURI: true,
    } as ConstructorParameters<typeof DatabaseSync>[1]);
  }
}

function main() {
  if (!existsSync(DB_PATH)) {
    console.error(`no encontré la base en ${DB_PATH}`);
    console.error("(¿lo estás corriendo desde la raíz del repo?)");
    process.exit(1);
  }

  const db = abrirParaLeer();
  const uno = <T>(sql: string, ...args: unknown[]): T =>
    (db.prepare(sql).get(...(args as never[])) as T) ?? ({} as T);
  const todos = <T>(sql: string, ...args: unknown[]): T[] =>
    db.prepare(sql).all(...(args as never[])) as T[];

  console.log(`\n=== Multi, últimos ${DIAS} días ===\n`);

  // ── Lo que se creó ────────────────────────────────────────────────────────
  const salas = uno<{ c: number }>(`SELECT COUNT(*) c FROM rooms WHERE created_at >= ?`, DESDE).c;
  const salasTotal = uno<{ c: number }>(`SELECT COUNT(*) c FROM rooms`).c;

  /**
   * Una sala "usada" es donde alguien le habló a un agente.
   *
   * Crear una sala es un click; pedirle algo a un agente es la primera vez que
   * Multi hace lo que promete. La diferencia entre los dos números es la gente
   * que entró, miró y se fue.
   */
  const salasUsadas = uno<{ c: number }>(
    `SELECT COUNT(DISTINCT room_id) c FROM messages WHERE role = 'agent' AND created_at >= ?`,
    DESDE,
  ).c;

  console.log(`Salas creadas:        ${salas}  (${salasTotal} en total)`);
  console.log(`Salas con un agente:  ${salasUsadas}${salas > 0 ? `  (${Math.round((salasUsadas / salas) * 100)}% de las nuevas)` : ""}`);

  // ── La gente ──────────────────────────────────────────────────────────────
  /**
   * Sin cuentas, la identidad es el nombre que cada quien escribe al entrar.
   * Dos personas que pongan "juan" cuentan como una, y quien se cambie el
   * nombre cuenta doble. Para saber si Multi se usa alcanza; para cobrar, no.
   */
  const personas = todos<{ author: string; mensajes: number; salas: number; ultimo: number }>(
    `SELECT author,
            COUNT(*) mensajes,
            COUNT(DISTINCT room_id) salas,
            MAX(created_at) ultimo
       FROM messages
      WHERE role = 'human' AND created_at >= ?
      GROUP BY author
      ORDER BY mensajes DESC`,
    DESDE,
  );

  console.log(`Personas distintas:   ${personas.length}`);

  // ── Lo que se le pidió a los agentes ──────────────────────────────────────
  const turnos = uno<{ c: number }>(
    `SELECT COUNT(*) c FROM messages WHERE role = 'agent' AND created_at >= ?`,
    DESDE,
  ).c;
  /**
   * `adjuntos` llegó después, y una BD de antes no la tiene: el server la
   * agrega al arrancar, pero este reporte abre en immutable y no migra nada.
   * Se pregunta por el esquema en vez de suponerlo, para que una base vieja no
   * tumbe el reporte entero por una sola línea.
   */
  const tieneAdjuntos = todos<{ name: string }>(`PRAGMA table_info(messages)`).some(
    (c) => c.name === "adjuntos",
  );
  const conImagen = tieneAdjuntos
    ? uno<{ c: number }>(
        `SELECT COUNT(*) c FROM messages WHERE adjuntos IS NOT NULL AND created_at >= ?`,
        DESDE,
      ).c
    : null;

  console.log(`Respuestas de agentes: ${turnos}`);
  if (conImagen !== null) console.log(`Mensajes con imagen:   ${conImagen}`);

  // ── Quién volvió ──────────────────────────────────────────────────────────
  /**
   * La métrica que de verdad contesta "¿les sirvió?".
   *
   * Volver otro día es la señal más honesta que hay: nadie regresa por
   * compromiso a una herramienta que no le resolvió nada. Se cuentan días
   * distintos y no sesiones, porque entrar dos veces la misma tarde es la misma
   * ocasión de uso.
   */
  const vueltas = todos<{ author: string; dias: number }>(
    `SELECT author, COUNT(DISTINCT CAST(created_at / ? AS INTEGER)) dias
       FROM messages
      WHERE role = 'human' AND created_at >= ?
      GROUP BY author
      HAVING dias > 1
      ORDER BY dias DESC`,
    DIA,
    DESDE,
  );

  console.log(`Volvieron otro día:    ${vueltas.length} de ${personas.length}`);

  // ── Salas compartidas ─────────────────────────────────────────────────────
  /**
   * Salas donde escribió más de una persona: la promesa de Multi cumpliéndose.
   * Si este número es cero, la gente lo está usando como un chat de IA
   * cualquiera y el multijugador no está pasando.
   */
  const compartidas = uno<{ c: number }>(
    `SELECT COUNT(*) c FROM (
       SELECT room_id
         FROM messages
        WHERE role = 'human' AND created_at >= ?
        GROUP BY room_id
       HAVING COUNT(DISTINCT author) > 1
     )`,
    DESDE,
  ).c;

  console.log(`Salas con 2+ personas: ${compartidas}${salasUsadas > 0 ? `  (de ${salasUsadas} usadas)` : ""}`);

  // ── El detalle ────────────────────────────────────────────────────────────
  if (personas.length > 0) {
    console.log(`\n--- quién ---`);
    for (const p of personas.slice(0, 15)) {
      const dias = vueltas.find((v) => v.author === p.author)?.dias ?? 1;
      console.log(
        `  ${p.author.padEnd(16)} ${String(p.mensajes).padStart(4)} mensajes  ` +
          `${String(p.salas).padStart(2)} sala(s)  ${dias} día(s)  · ${hace(p.ultimo)}`,
      );
    }
  }

  // Por día, para ver si crece o se apaga.
  const porDia = todos<{ dia: number; mensajes: number; gente: number }>(
    `SELECT CAST(created_at / ? AS INTEGER) dia,
            COUNT(*) mensajes,
            COUNT(DISTINCT author) gente
       FROM messages
      WHERE role = 'human' AND created_at >= ?
      GROUP BY dia
      ORDER BY dia`,
    DIA,
    DESDE,
  );

  if (porDia.length > 0) {
    console.log(`\n--- por día ---`);
    const tope = Math.max(...porDia.map((d) => d.mensajes));
    for (const d of porDia) {
      const fecha = new Date(d.dia * DIA).toISOString().slice(0, 10);
      // Una barra de texto dice de un vistazo lo que una columna de números no.
      const barra = "#".repeat(Math.max(1, Math.round((d.mensajes / tope) * 30)));
      console.log(`  ${fecha}  ${barra} ${d.mensajes} (${d.gente} personas)`);
    }
  }

  if (salas === 0) {
    console.log(`\nNadie ha creado una sala en estos ${DIAS} días.`);
  }

  console.log();
  db.close();
}

/** Cuánto hace, en palabras. Una fecha exacta aquí no dice nada útil. */
function hace(ms: number): string {
  const min = Math.floor((Date.now() - ms) / 60000);
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.floor(h / 24)} día(s)`;
}

main();
