import { join } from "node:path";
import { SqliteStorage } from "./sqlite.js";
import type { Storage } from "./types.js";

export * from "./types.js";

/** La BD vive junto a los workspaces, fuera del repo (gitignored). */
const DB_PATH = process.env.MULTI_DB ?? join(process.cwd(), "..", "workspaces", "multi.db");

let instance: Storage | null = null;

/** Storage compartido del proceso. SQLite por defecto. */
export async function getStorage(): Promise<Storage> {
  if (instance) return instance;
  const storage = new SqliteStorage(DB_PATH);
  await storage.init();
  instance = storage;
  return storage;
}
