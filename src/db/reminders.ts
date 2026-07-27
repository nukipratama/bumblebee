import type { StatementSync } from "node:sqlite";
import { db } from "./index.js";

export interface Reminder {
  id: number;
  channelId: string;
  code: string;
  at: string;
  days: string;
  message: string;
  everyNWeeks: number;
  enabled: boolean;
  lastFiredAt: string | null;
  createdBy: string;
  createdAt: string;
}

export interface NewReminder {
  channelId: string;
  code: string;
  at: string;
  days: string;
  message: string;
  everyNWeeks: number;
  createdBy: string;
}

export interface Holiday {
  date: string;
  addedBy: string;
  addedInChannel: string;
  addedAt: string;
}

/**
 * A roster member. `lapOrder` is their place in the current lap, or null once
 * they've hosted it. Structurally a `LapMember`, deliberately declared here
 * rather than imported: `rotation.ts` states the minimal shape its pure
 * functions need, and shouldn't grow a field because this row gained a column.
 */
export interface Host {
  userId: string;
  lapOrder: number | null;
}

export interface FireRecord {
  reminderId: number;
  firedOn: string;
  firedAt: Date;
  hostUserId: string | null;
  messageTs: string | null;
  nextLap: readonly string[];
}

// Statements are prepared lazily (memoized) rather than at module load, because
// the tables don't exist until initDb() runs its migrations at startup.
const statements = new Map<string, StatementSync>();

function stmt(sql: string): StatementSync {
  let prepared = statements.get(sql);
  if (!prepared) {
    prepared = db.prepare(sql);
    statements.set(sql, prepared);
  }
  return prepared;
}

function transaction(work: () => void): void {
  db.exec("BEGIN");
  try {
    work();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

const REMINDER_COLUMNS = `id,
         channel_id    AS channelId,
         code,
         at,
         days,
         message,
         every_n_weeks AS everyNWeeks,
         enabled,
         last_fired_at AS lastFiredAt,
         created_by    AS createdBy,
         created_at    AS createdAt`;

const HOLIDAY_COLUMNS = `date,
         added_by         AS addedBy,
         added_in_channel AS addedInChannel,
         added_at         AS addedAt`;

type ReminderRow = Omit<Reminder, "enabled"> & { enabled: number };

const toReminder = (row: ReminderRow): Reminder => ({ ...row, enabled: row.enabled === 1 });

export function insertReminder(reminder: NewReminder): void {
  stmt(
    `INSERT INTO reminders
       (channel_id, code, at, days, message, every_n_weeks, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    reminder.channelId,
    reminder.code,
    reminder.at,
    reminder.days,
    reminder.message,
    reminder.everyNWeeks,
    reminder.createdBy,
    new Date().toISOString(),
  );
}

export function getReminder(channelId: string, code: string): Reminder | undefined {
  const row = stmt(
    `SELECT ${REMINDER_COLUMNS} FROM reminders WHERE channel_id = ? AND code = ?`,
  ).get(channelId, code) as unknown as ReminderRow | undefined;
  return row && toReminder(row);
}

export function listReminders(channelId: string): Reminder[] {
  const rows = stmt(
    `SELECT ${REMINDER_COLUMNS} FROM reminders WHERE channel_id = ? ORDER BY at, code`,
  ).all(channelId) as unknown as ReminderRow[];
  return rows.map(toReminder);
}

export function listEnabledReminders(): Reminder[] {
  const rows = stmt(
    `SELECT ${REMINDER_COLUMNS} FROM reminders WHERE enabled = 1 ORDER BY channel_id, at`,
  ).all() as unknown as ReminderRow[];
  return rows.map(toReminder);
}

export function setReminderAt(channelId: string, code: string, at: string): void {
  stmt("UPDATE reminders SET at = ? WHERE channel_id = ? AND code = ?").run(at, channelId, code);
}

export function setReminderDays(channelId: string, code: string, days: string): void {
  stmt("UPDATE reminders SET days = ? WHERE channel_id = ? AND code = ?").run(
    days,
    channelId,
    code,
  );
}

export function setReminderMessage(channelId: string, code: string, message: string): void {
  stmt("UPDATE reminders SET message = ? WHERE channel_id = ? AND code = ?").run(
    message,
    channelId,
    code,
  );
}

export function setReminderCadence(channelId: string, code: string, everyNWeeks: number): void {
  stmt("UPDATE reminders SET every_n_weeks = ? WHERE channel_id = ? AND code = ?").run(
    everyNWeeks,
    channelId,
    code,
  );
}

export function setReminderEnabled(channelId: string, code: string, enabled: boolean): void {
  stmt("UPDATE reminders SET enabled = ? WHERE channel_id = ? AND code = ?").run(
    enabled ? 1 : 0,
    channelId,
    code,
  );
}

export function deleteReminder(channelId: string, code: string): void {
  stmt("DELETE FROM reminders WHERE channel_id = ? AND code = ?").run(channelId, code);
}

/**
 * Everything a successful post writes: the fire stamp, the history row, and the
 * advanced lap. One transaction, because a crash between them would record a
 * post whose host is still up next tomorrow.
 *
 * Stamps the time from JS, never SQLite — see the last_fired_at gotcha.
 */
export function recordFire(record: FireRecord): void {
  transaction(() => {
    stmt("UPDATE reminders SET last_fired_at = ? WHERE id = ?").run(
      record.firedAt.toISOString(),
      record.reminderId,
    );
    stmt(
      `INSERT INTO reminder_fires (reminder_id, fired_on, host_user_id, message_ts)
       VALUES (?, ?, ?, ?)`,
    ).run(record.reminderId, record.firedOn, record.hostUserId, record.messageTs);
    writeLap(record.reminderId, record.nextLap);
  });
}

export function countReminders(channelId: string): { enabled: number; paused: number } {
  return stmt(
    `SELECT COALESCE(SUM(enabled), 0)     AS enabled,
            COALESCE(SUM(1 - enabled), 0) AS paused
       FROM reminders
      WHERE channel_id = ?`,
  ).get(channelId) as unknown as { enabled: number; paused: number };
}

export function insertHoliday(holiday: Omit<Holiday, "addedAt">): void {
  stmt(
    `INSERT INTO holidays (date, added_by, added_in_channel, added_at) VALUES (?, ?, ?, ?)`,
  ).run(holiday.date, holiday.addedBy, holiday.addedInChannel, new Date().toISOString());
}

export function getHoliday(date: string): Holiday | undefined {
  return stmt(`SELECT ${HOLIDAY_COLUMNS} FROM holidays WHERE date = ?`).get(date) as unknown as
    | Holiday
    | undefined;
}

export function listHolidays(): Holiday[] {
  return stmt(`SELECT ${HOLIDAY_COLUMNS} FROM holidays ORDER BY date`).all() as unknown as Holiday[];
}

export function listHolidayDates(): Set<string> {
  const rows = stmt("SELECT date FROM holidays").all() as unknown as { date: string }[];
  return new Set(rows.map((row) => row.date));
}

export function deleteHoliday(date: string): void {
  stmt("DELETE FROM holidays WHERE date = ?").run(date);
}

/** Roster rows for a reminder: those who have hosted this lap first, then the pending lap in order. */
export function listHosts(reminderId: number): Host[] {
  return stmt(
    `SELECT user_id AS userId, lap_order AS lapOrder
       FROM reminder_hosts
      WHERE reminder_id = ?
      ORDER BY lap_order`,
  ).all(reminderId) as unknown as Host[];
}

function writeLap(reminderId: number, lap: readonly string[]): void {
  stmt("UPDATE reminder_hosts SET lap_order = NULL WHERE reminder_id = ?").run(reminderId);
  const place = stmt(
    "UPDATE reminder_hosts SET lap_order = ? WHERE reminder_id = ? AND user_id = ?",
  );
  lap.forEach((userId, index) => place.run(index, reminderId, userId));
}

export function setLap(reminderId: number, lap: readonly string[]): void {
  transaction(() => writeLap(reminderId, lap));
}

/**
 * Replace the roster. Anyone in `userIds` but absent from `lap` is recorded as
 * having already hosted this lap — which is how `host set` avoids handing
 * someone a second turn. Callers build `lap` with `planLap`.
 */
export function replaceHosts(
  reminderId: number,
  userIds: readonly string[],
  lap: readonly string[],
): void {
  transaction(() => {
    stmt("DELETE FROM reminder_hosts WHERE reminder_id = ?").run(reminderId);
    const add = stmt(
      "INSERT INTO reminder_hosts (reminder_id, user_id, lap_order) VALUES (?, ?, ?)",
    );
    for (const userId of userIds) {
      const place = lap.indexOf(userId);
      add.run(reminderId, userId, place === -1 ? null : place);
    }
  });
}

export function clearHosts(reminderId: number): void {
  stmt("DELETE FROM reminder_hosts WHERE reminder_id = ?").run(reminderId);
}

/** Most recent hosting date per user, which is what dates the ✓ rows in `show`. */
export function lastHostedOn(reminderId: number): Map<string, string> {
  const rows = stmt(
    `SELECT host_user_id AS userId, MAX(fired_on) AS firedOn
       FROM reminder_fires
      WHERE reminder_id = ? AND host_user_id IS NOT NULL
      GROUP BY host_user_id`,
  ).all(reminderId) as unknown as { userId: string; firedOn: string }[];
  return new Map(rows.map((row) => [row.userId, row.firedOn]));
}
