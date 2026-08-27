import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Message } from "../agent/providers/types.js";
import type {
  SalaDeUsuario,
  Storage,
  StoredMessage,
  StoredRoom,
  StoredUsuario,
} from "./types.js";

/**
 * Persistencia con SQLite (node:sqlite, nativo en Node 22 — cero dependencias).
 *
 * Es el default a propósito: alguien clona el repo, corre npm install, y
 * funciona. Sin crear cuentas ni configurar credenciales. Ese quickstart de
 * "clonar y correr" es lo que hace que un proyecto open source se pruebe.
 */
export class SqliteStorage implements Storage {
  private db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // WAL: mejor concurrencia lectura/escritura (varias salas a la vez).
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  async init(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        id             TEXT PRIMARY KEY,
        workspace_dir  TEXT NOT NULL,
        created_at     INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL,
        -- Cómo le dice la gente a esta sala. El id no cambia nunca (es la URL y
        -- lo que se dicta por teléfono); esto es solo la etiqueta que se ve.
        nombre         TEXT,
        -- Dónde quedó publicada la app, si es que se publicó.
        url_publicada  TEXT
      );

      CREATE TABLE IF NOT EXISTS messages (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id     TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        author      TEXT NOT NULL,
        color       TEXT NOT NULL,
        role        TEXT NOT NULL,
        text        TEXT NOT NULL,
        anchored_to TEXT,
        adjuntos    TEXT,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_room_idx ON messages(room_id, id);

      CREATE TABLE IF NOT EXISTS agent_histories (
        room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        agent_id   TEXT NOT NULL,
        messages   TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (room_id, agent_id)
      );

      -- Quien quiso tener cuenta. La mayoría de la gente no va a estar aquí, y
      -- eso está bien: entrar a una sala nunca la pide.
      CREATE TABLE IF NOT EXISTS usuarios (
        id         TEXT PRIMARY KEY,
        -- El identificador de Google. Es lo que no cambia aunque la persona
        -- cambie de correo, así que la cuenta se ata a esto y no al correo.
        google_sub TEXT NOT NULL UNIQUE,
        nombre     TEXT NOT NULL,
        correo     TEXT NOT NULL,
        -- La URL de la foto en los servidores de Google. Se guarda la URL y no
        -- la imagen: es pública y estable, y bajarla sería hospedar fotos de
        -- perfil para no ganar nada.
        foto       TEXT,
        creado_en  INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sesiones (
        token      TEXT PRIMARY KEY,
        usuario_id TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        creada_en  INTEGER NOT NULL,
        expira_en  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sesiones_usuario_idx ON sesiones(usuario_id);

      -- Las salas de quien tiene cuenta: el mismo historial que sin cuenta vive
      -- en el navegador, pero que aquí le sigue al celular y sobrevive a un
      -- borrado de datos del navegador.
      CREATE TABLE IF NOT EXISTS salas_de_usuario (
        usuario_id  TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        room_id     TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        visitada_en INTEGER NOT NULL,
        PRIMARY KEY (usuario_id, room_id)
      );
    `);

    // Las salas que ya existían tienen la tabla sin la columna de adjuntos: el
    // CREATE de arriba no las toca porque lleva IF NOT EXISTS. Agregarla a mano
    // y tragarse el error si ya está es la forma barata de migrar sin llevar
    // versiones de esquema, que para una columna nueva sería desproporcionado.
    try {
      this.db.exec(`ALTER TABLE messages ADD COLUMN adjuntos TEXT`);
    } catch {
      // ya la tiene
    }

    // Dónde quedó publicada la app de esta sala, si es que se publicó. Nullable:
    // sin esto no hay forma de saber, al volver mañana, si la sala está en vivo.
    try {
      this.db.exec(`ALTER TABLE rooms ADD COLUMN url_publicada TEXT`);
    } catch {
      // ya la tiene
    }

    // El nombre que la gente le pone a la sala. Nullable a propósito: sin él la
    // interfaz cae al id, que es lo que se ha visto siempre.
    try {
      this.db.exec(`ALTER TABLE rooms ADD COLUMN nombre TEXT`);
    } catch {
      // ya la tiene
    }

    // Quién escribió el mensaje, si tenía cuenta. Sirve para pintar su foto.
    //
    // Lo de antes se queda en NULL y NO se rellena hacia atrás: atarlo por
    // coincidencia de nombre sería adivinar, y dos personas distintas pueden
    // haberse llamado igual en salas distintas. Atribuirle a alguien mensajes
    // que no escribió es peor que mostrar una inicial.
    //
    // Sin FK a propósito: con ON DELETE CASCADE, borrar una cuenta borraría los
    // mensajes de esa persona, y lo que se dijo en la sala es de la sala. Así,
    // la columna queda apuntando a nadie y el mensaje cae a su inicial.
    try {
      this.db.exec(`ALTER TABLE messages ADD COLUMN usuario_id TEXT`);
    } catch {
      // ya la tiene
    }
  }

  async createRoom(room: StoredRoom): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO rooms (id, workspace_dir, created_at, last_active_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(room.id, room.workspaceDir, room.createdAt, room.lastActiveAt);
  }

  async getRoom(id: string): Promise<StoredRoom | null> {
    const row = this.db.prepare(`SELECT * FROM rooms WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? toRoom(row) : null;
  }

  async listRooms(): Promise<StoredRoom[]> {
    const rows = this.db
      .prepare(`SELECT * FROM rooms ORDER BY last_active_at DESC`)
      .all() as Record<string, unknown>[];
    return rows.map(toRoom);
  }

  async touchRoom(id: string): Promise<void> {
    this.db.prepare(`UPDATE rooms SET last_active_at = ? WHERE id = ?`).run(Date.now(), id);
  }

  async renameRoom(id: string, nombre: string | null): Promise<void> {
    this.db.prepare(`UPDATE rooms SET nombre = ? WHERE id = ?`).run(nombre, id);
  }

  async setUrlPublicada(id: string, url: string): Promise<void> {
    this.db.prepare(`UPDATE rooms SET url_publicada = ? WHERE id = ?`).run(url, id);
  }

  /**
   * Los mensajes y los historiales se van solos: sus tablas declaran
   * `ON DELETE CASCADE` contra `rooms(id)` y el PRAGMA de claves foráneas está
   * activo desde el constructor. Aun así se borran a mano primero, porque si
   * ese PRAGMA se cayera algún día esto dejaría filas huérfanas en silencio y
   * la BD crecería sin que nadie lo notara.
   */
  async deleteRoom(id: string): Promise<void> {
    this.db.prepare(`DELETE FROM agent_histories WHERE room_id = ?`).run(id);
    this.db.prepare(`DELETE FROM messages WHERE room_id = ?`).run(id);
    this.db.prepare(`DELETE FROM rooms WHERE id = ?`).run(id);
  }

  async appendMessage(m: StoredMessage): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO messages (room_id, author, color, role, text, anchored_to, adjuntos, created_at, usuario_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.roomId,
        m.author,
        m.color,
        m.role,
        m.text,
        m.anchoredTo ?? null,
        m.adjuntos?.length ? JSON.stringify(m.adjuntos) : null,
        m.createdAt,
        m.usuarioId ?? null,
      );
  }

  /**
   * Los últimos mensajes de la sala, con la foto de quien los escribió.
   *
   * La foto sale de un JOIN y no de la fila: si alguien cambia su foto, sus
   * mensajes viejos muestran la nueva. Es lo que hace todo el mundo y lo que la
   * gente espera. El LEFT es lo que importa: la enorme mayoría de los mensajes
   * no tiene cuenta detrás y tienen que salir igual.
   */
  async getMessages(roomId: string, limit = 200): Promise<StoredMessage[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT m.*, u.foto AS foto_usuario
           FROM messages m
           LEFT JOIN usuarios u ON u.id = m.usuario_id
           WHERE m.room_id = ? ORDER BY m.id DESC LIMIT ?
         ) ORDER BY id ASC`,
      )
      .all(roomId, limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      roomId: String(r.room_id),
      author: String(r.author),
      color: String(r.color),
      role: String(r.role) as StoredMessage["role"],
      text: String(r.text),
      anchoredTo: r.anchored_to ? String(r.anchored_to) : undefined,
      adjuntos: parseAdjuntos(r.adjuntos),
      createdAt: Number(r.created_at),
      usuarioId: r.usuario_id ? String(r.usuario_id) : null,
      foto: r.foto_usuario ? String(r.foto_usuario) : null,
    }));
  }

  async saveAgentHistory(roomId: string, agentId: string, messages: Message[]): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO agent_histories (room_id, agent_id, messages, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(room_id, agent_id) DO UPDATE SET messages = excluded.messages,
                                                      updated_at = excluded.updated_at`,
      )
      .run(roomId, agentId, JSON.stringify(messages), Date.now());
  }

  async listAgentIds(roomId: string): Promise<string[]> {
    const filas = this.db
      .prepare(`SELECT agent_id FROM agent_histories WHERE room_id = ? ORDER BY agent_id`)
      .all(roomId) as Array<{ agent_id: string }>;
    return filas.map((f) => f.agent_id);
  }

  async getAgentHistory(roomId: string, agentId: string): Promise<Message[]> {
    const row = this.db
      .prepare(`SELECT messages FROM agent_histories WHERE room_id = ? AND agent_id = ?`)
      .get(roomId, agentId) as { messages?: string } | undefined;
    if (!row?.messages) return [];
    try {
      return JSON.parse(row.messages) as Message[];
    } catch {
      return [];
    }
  }

  // ── Cuentas ─────────────────────────────────────────────────────────────

  async usuarioPorGoogleSub(googleSub: string): Promise<StoredUsuario | null> {
    const row = this.db
      .prepare(`SELECT * FROM usuarios WHERE google_sub = ?`)
      .get(googleSub) as Record<string, unknown> | undefined;
    return row ? toUsuario(row) : null;
  }

  async crearUsuario(u: StoredUsuario): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO usuarios (id, google_sub, nombre, correo, foto, creado_en)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(u.id, u.googleSub, u.nombre, u.correo, u.foto ?? null, u.creadoEn);
  }

  async actualizarUsuario(
    id: string,
    datos: { nombre: string; correo: string; foto: string | null },
  ): Promise<void> {
    this.db
      .prepare(`UPDATE usuarios SET nombre = ?, correo = ?, foto = ? WHERE id = ?`)
      .run(datos.nombre, datos.correo, datos.foto, id);
  }

  /**
   * El dueño de una sesión, comprobando de paso que no haya vencido.
   *
   * La expiración se filtra en el SELECT y no después: así una sesión vencida
   * es indistinguible de una que no existe, y no hay forma de olvidarse de
   * comprobarla en algún camino.
   */
  async usuarioPorSesion(token: string): Promise<StoredUsuario | null> {
    const row = this.db
      .prepare(
        `SELECT u.* FROM sesiones s
         JOIN usuarios u ON u.id = s.usuario_id
         WHERE s.token = ? AND s.expira_en > ?`,
      )
      .get(token, Date.now()) as Record<string, unknown> | undefined;
    return row ? toUsuario(row) : null;
  }

  async crearSesion(token: string, usuarioId: string, expiraEn: number): Promise<void> {
    this.db
      .prepare(`INSERT INTO sesiones (token, usuario_id, creada_en, expira_en) VALUES (?, ?, ?, ?)`)
      .run(token, usuarioId, Date.now(), expiraEn);
  }

  async borrarSesion(token: string): Promise<void> {
    this.db.prepare(`DELETE FROM sesiones WHERE token = ?`).run(token);
  }

  async borrarSesionesVencidas(): Promise<void> {
    this.db.prepare(`DELETE FROM sesiones WHERE expira_en <= ?`).run(Date.now());
  }

  /**
   * Las salas de alguien, de la visita más reciente hacia atrás.
   *
   * El JOIN contra `rooms` no es decorativo: filtra las que ya se borraron. Sin
   * él la cuenta acumularía para siempre salas que no existen.
   */
  async salasDeUsuario(usuarioId: string): Promise<SalaDeUsuario[]> {
    const rows = this.db
      .prepare(
        `SELECT s.room_id, s.visitada_en, r.nombre FROM salas_de_usuario s
         JOIN rooms r ON r.id = s.room_id
         WHERE s.usuario_id = ? ORDER BY s.visitada_en DESC`,
      )
      .all(usuarioId) as Record<string, unknown>[];
    return rows.map((r) => ({
      roomId: String(r.room_id),
      visitadaEn: Number(r.visitada_en),
      // El nombre sale del JOIN que ya estaba ahi. Sin el, la lista de quien
      // entra con cuenta pisaba la del navegador (que si los tenia) y todas las
      // salas volvian a verse por su id.
      nombre: r.nombre == null ? null : String(r.nombre),
    }));
  }

  async recordarSalaDeUsuario(usuarioId: string, roomId: string): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO salas_de_usuario (usuario_id, room_id, visitada_en) VALUES (?, ?, ?)
         ON CONFLICT(usuario_id, room_id) DO UPDATE SET visitada_en = excluded.visitada_en`,
      )
      .run(usuarioId, roomId, Date.now());
  }

  async olvidarSalaDeUsuario(usuarioId: string, roomId: string): Promise<void> {
    this.db
      .prepare(`DELETE FROM salas_de_usuario WHERE usuario_id = ? AND room_id = ?`)
      .run(usuarioId, roomId);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

function toUsuario(r: Record<string, unknown>): StoredUsuario {
  return {
    id: String(r.id),
    googleSub: String(r.google_sub),
    nombre: String(r.nombre),
    correo: String(r.correo),
    foto: r.foto == null ? null : String(r.foto),
    creadoEn: Number(r.creado_en),
  };
}

/**
 * Los adjuntos de un mensaje, desde la columna.
 *
 * Llega null en todo lo anterior a esta columna, que son las 44 salas que ya
 * existían. Un JSON corrupto tampoco debe tumbar la carga del chat: si no se
 * puede leer, el mensaje se muestra sin sus imágenes, que es mejor que no
 * mostrar el mensaje.
 */
function parseAdjuntos(v: unknown): StoredMessage["adjuntos"] {
  if (typeof v !== "string" || !v) return undefined;
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) && parsed.length ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function toRoom(r: Record<string, unknown>): StoredRoom {
  return {
    id: String(r.id),
    workspaceDir: String(r.workspace_dir),
    createdAt: Number(r.created_at),
    lastActiveAt: Number(r.last_active_at),
    // Las salas de antes de esta columna la traen en null, y ahí la interfaz
    // cae al id.
    nombre: r.nombre == null ? null : String(r.nombre),
    urlPublicada: r.url_publicada == null ? null : String(r.url_publicada),
  };
}
