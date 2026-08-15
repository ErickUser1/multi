import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Message } from "../agent/providers/types.js";
import type { Storage, StoredMessage, StoredRoom } from "./types.js";

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
        `INSERT INTO messages (room_id, author, color, role, text, anchored_to, adjuntos, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
  }

  async getMessages(roomId: string, limit = 200): Promise<StoredMessage[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM messages WHERE room_id = ? ORDER BY id DESC LIMIT ?
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

  async close(): Promise<void> {
    this.db.close();
  }
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
