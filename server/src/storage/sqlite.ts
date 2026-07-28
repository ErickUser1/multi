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
        last_active_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id     TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        author      TEXT NOT NULL,
        color       TEXT NOT NULL,
        role        TEXT NOT NULL,
        text        TEXT NOT NULL,
        anchored_to TEXT,
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

  async appendMessage(m: StoredMessage): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO messages (room_id, author, color, role, text, anchored_to, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(m.roomId, m.author, m.color, m.role, m.text, m.anchoredTo ?? null, m.createdAt);
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

function toRoom(r: Record<string, unknown>): StoredRoom {
  return {
    id: String(r.id),
    workspaceDir: String(r.workspace_dir),
    createdAt: Number(r.created_at),
    lastActiveAt: Number(r.last_active_at),
  };
}
