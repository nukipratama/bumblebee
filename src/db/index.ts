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
  `CREATE TABLE reminders (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     channel_id    TEXT    NOT NULL,
     code          TEXT    NOT NULL,
     at            TEXT    NOT NULL,
     days          TEXT    NOT NULL,
     message       TEXT    NOT NULL,
     every_n_weeks INTEGER NOT NULL DEFAULT 1 CHECK (every_n_weeks IN (1, 2, 3)),
     enabled       INTEGER NOT NULL DEFAULT 1,
     last_fired_at TEXT,
     created_by    TEXT    NOT NULL,
     created_at    TEXT    NOT NULL,
     UNIQUE (channel_id, code)
   )`,
  `CREATE TABLE holidays (
     date             TEXT PRIMARY KEY,
     added_by         TEXT NOT NULL,
     added_in_channel TEXT NOT NULL,
     added_at         TEXT NOT NULL
   )`,
  // A host is pending this lap while lap_order is a number, and has already
  // hosted once it is NULL. Up next is the lowest number; the lap is over when
  // no row has one.
  `CREATE TABLE reminder_hosts (
     reminder_id INTEGER NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
     user_id     TEXT    NOT NULL,
     lap_order   INTEGER,
     PRIMARY KEY (reminder_id, user_id)
   )`,
  `CREATE TABLE reminder_fires (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     reminder_id  INTEGER NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
     fired_on     TEXT    NOT NULL,
     host_user_id TEXT,
     message_ts   TEXT
   )`,
  // Which flavour of markup `message` is written in. Slash-command messages are
  // standard Markdown; ones captured from a Slack message are mrkdwn, where the
  // same asterisks mean something else. Stored so each is rendered through the
  // matching block type rather than converted.
  `ALTER TABLE reminders
     ADD COLUMN body_format TEXT NOT NULL DEFAULT 'markdown'
     CHECK (body_format IN ('markdown', 'mrkdwn'))`,
  `CREATE TABLE reminder_skips (
     fire_id    INTEGER NOT NULL REFERENCES reminder_fires(id) ON DELETE CASCADE,
     user_id    TEXT    NOT NULL,
     created_at TEXT    NOT NULL,
     PRIMARY KEY (fire_id, user_id)
   )`,
  // fired_on is only a date, but the handover window is measured in minutes.
  // Null on rows written before this column existed, which reads as "too old to
  // hand over" — the right answer for a fire that already happened.
  `ALTER TABLE reminder_fires ADD COLUMN fired_at TEXT`,
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
