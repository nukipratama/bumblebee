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

/** Stamp the fire time from JS, never SQLite — see the last_fired_at gotcha. */
export function markFired(id: number, firedAt: Date): void {
  stmt("UPDATE reminders SET last_fired_at = ? WHERE id = ?").run(firedAt.toISOString(), id);
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
