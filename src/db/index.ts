import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "../config.js";

// DatabaseSync won't create a missing parent directory, so ensure it exists
// before opening (matters for the default local `./data/` path).
mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

// Ordered, append-only schema migrations. Each entry's index is its version;
// on start we apply every migration past the DB's current `user_version` and
// bump it. Add new features by appending a statement here — never edit an
// existing one.
const migrations: string[] = [
  `CREATE TABLE ai_usage (
     id                INTEGER PRIMARY KEY AUTOINCREMENT,
     created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
     slack_user_id     TEXT,
     channel_id        TEXT,
     model             TEXT    NOT NULL,
     prompt_tokens     INTEGER NOT NULL,
     completion_tokens INTEGER NOT NULL,
     total_tokens      INTEGER NOT NULL
   )`,
];

/** Apply any pending schema migrations. Idempotent; safe to call on every boot. */
export function initDb(): void {
  const { user_version: current } = db.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  for (let version = current; version < migrations.length; version++) {
    db.exec(migrations[version]!);
    // user_version takes a literal, not a bound parameter.
    db.exec(`PRAGMA user_version = ${version + 1}`);
  }
}
