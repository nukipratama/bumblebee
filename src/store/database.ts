import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { config } from "../config.js";

// DatabaseSync will not create a missing parent directory.
mkdirSync(dirname(config.dbPath), { recursive: true });

const db = new DatabaseSync(config.dbPath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

// Append-only: each entry's index is its version. Never edit an existing one.
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
  // lap_order is a number while that person is pending this lap and NULL once
  // they have hosted it. Up next is the lowest number; the lap is over when no
  // row has one. No pointer column, so there is no "current host" to drift.
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
  `ALTER TABLE reminder_fires ADD COLUMN fired_at TEXT`,
  // Pause/resume is gone and the scheduler no longer filters on `enabled`, so a
  // row left at 0 would silently start firing. Normalise it here instead. The
  // column itself has to stay: these migrations are append-only.
  `UPDATE reminders SET enabled = 1 WHERE enabled = 0`,
  // Optional free text, so NULL is "they gave no reason", not a missing answer.
  `ALTER TABLE reminder_skips ADD COLUMN reason TEXT`,
  // The thread reply carrying that reason, so editing rewrites it instead of piling up.
  `ALTER TABLE reminder_skips ADD COLUMN notice_ts TEXT`,
  // How far before `at` the reminder fires. The post at `at` stays the meeting
  // ping; firing early is what gives a host time to hand over beforehand.
  `ALTER TABLE reminders ADD COLUMN lead_minutes INTEGER NOT NULL DEFAULT 0`,
  // NULL until a reminder opts into a lead, which is also when it becomes required.
  `ALTER TABLE reminders ADD COLUMN pre_message TEXT`,
  // One fire, two posts: either message ts must resolve back to this row.
  `ALTER TABLE reminder_fires ADD COLUMN join_message_ts TEXT`,
  // Reasons render on the posts themselves now, so there is no reply to remember.
  `ALTER TABLE reminder_skips DROP COLUMN notice_ts`,
  // Soft-deleted via `active`, not dropped — a removed repo's past rounds still
  // reference it by id, and a hard delete would either orphan them or cascade.
  `CREATE TABLE cf_repos (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     name       TEXT    NOT NULL UNIQUE,
     active     INTEGER NOT NULL DEFAULT 1,
     created_at TEXT    NOT NULL
   )`,
  // Single row (id fixed at 1). Only meaningful for the recurring trigger — a
  // manual Start now posts to whatever channel it was run from and never reads this.
  `CREATE TABLE cf_schedule (
     id              INTEGER PRIMARY KEY CHECK (id = 1),
     channel_id      TEXT    NOT NULL,
     at_time         TEXT    NOT NULL,
     days            TEXT    NOT NULL,
     last_fired_date TEXT
   )`,
  `CREATE TABLE cf_rounds (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     started_by TEXT NOT NULL,
     started_at TEXT NOT NULL
   )`,
  `CREATE TABLE cf_messages (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     round_id   INTEGER NOT NULL REFERENCES cf_rounds(id) ON DELETE CASCADE,
     repo_id    INTEGER NOT NULL REFERENCES cf_repos(id),
     channel_id TEXT    NOT NULL,
     message_ts TEXT    NOT NULL,
     UNIQUE (round_id, repo_id)
   )`,
  // Latest status per squad per message — a re-click overwrites via upsert rather
  // than piling up rows, since only the latest click is ever shown.
  `CREATE TABLE cf_responses (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     message_id   INTEGER NOT NULL REFERENCES cf_messages(id) ON DELETE CASCADE,
     squad        TEXT    NOT NULL,
     status       TEXT    NOT NULL CHECK (status IN ('all_merged', 'no_mr')),
     responded_by TEXT    NOT NULL,
     responded_at TEXT    NOT NULL,
     UNIQUE (message_id, squad)
   )`,
];

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

// Prepared lazily, because no table exists until initDb() has run.
const prepared = new Map<string, StatementSync>();

export function stmt(sql: string): StatementSync {
  let statement = prepared.get(sql);
  if (!statement) {
    statement = db.prepare(sql);
    prepared.set(sql, statement);
  }
  return statement;
}

export function transaction(work: () => void): void {
  db.exec("BEGIN");
  try {
    work();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
