import type {
  Fire,
  Holiday,
  Host,
  NewFire,
  NewReminder,
  Reminder,
} from "../domain/types.js";
import { stmt, transaction } from "./database.js";

const REMINDER_COLUMNS = `id,
         channel_id    AS channelId,
         code,
         at,
         days,
         message,
         body_format   AS bodyFormat,
         every_n_weeks AS everyNWeeks,
         last_fired_at AS lastFiredAt,
         created_by    AS createdBy,
         created_at    AS createdAt`;

const FIRE_COLUMNS = `id,
         reminder_id  AS reminderId,
         fired_on     AS firedOn,
         fired_at     AS firedAt,
         host_user_id AS hostUserId,
         message_ts   AS messageTs`;

const HOLIDAY_COLUMNS = `date,
         added_by         AS addedBy,
         added_in_channel AS addedInChannel,
         added_at         AS addedAt`;

export function insertReminder(reminder: NewReminder): void {
  stmt(
    `INSERT INTO reminders
       (channel_id, code, at, days, message, body_format, every_n_weeks, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    reminder.channelId,
    reminder.code,
    reminder.at,
    reminder.days,
    reminder.message,
    reminder.bodyFormat,
    reminder.everyNWeeks,
    reminder.createdBy,
    new Date().toISOString(),
  );
}

export function getReminder(channelId: string, code: string): Reminder | undefined {
  return stmt(`SELECT ${REMINDER_COLUMNS} FROM reminders WHERE channel_id = ? AND code = ?`).get(
    channelId,
    code,
  ) as unknown as Reminder | undefined;
}

export function getReminderById(id: number): Reminder | undefined {
  return stmt(`SELECT ${REMINDER_COLUMNS} FROM reminders WHERE id = ?`).get(id) as unknown as
    | Reminder
    | undefined;
}

export function listReminders(channelId: string): Reminder[] {
  return stmt(
    `SELECT ${REMINDER_COLUMNS} FROM reminders WHERE channel_id = ? ORDER BY at, code`,
  ).all(channelId) as unknown as Reminder[];
}

export function listAllReminders(): Reminder[] {
  return stmt(
    `SELECT ${REMINDER_COLUMNS} FROM reminders ORDER BY channel_id, at`,
  ).all() as unknown as Reminder[];
}

export function setReminderAt(channelId: string, code: string, at: string): void {
  stmt("UPDATE reminders SET at = ? WHERE channel_id = ? AND code = ?").run(at, channelId, code);
}

export function setReminderDays(channelId: string, code: string, days: string): void {
  stmt("UPDATE reminders SET days = ? WHERE channel_id = ? AND code = ?").run(days, channelId, code);
}

/**
 * Resets body_format too: text typed into the form is Markdown. Call this only
 * when the message actually changed — see `plannedEdit` — or a body captured
 * from a Slack message gets silently reinterpreted.
 */
export function setReminderMessage(channelId: string, code: string, message: string): void {
  stmt(
    "UPDATE reminders SET message = ?, body_format = 'markdown' WHERE channel_id = ? AND code = ?",
  ).run(message, channelId, code);
}

export function setReminderCadence(channelId: string, code: string, everyNWeeks: number): void {
  stmt("UPDATE reminders SET every_n_weeks = ? WHERE channel_id = ? AND code = ?").run(
    everyNWeeks,
    channelId,
    code,
  );
}

export function deleteReminder(channelId: string, code: string): void {
  stmt("DELETE FROM reminders WHERE channel_id = ? AND code = ?").run(channelId, code);
}

/**
 * One transaction: a crash between these would record a post whose host is still
 * up next tomorrow. Stamps the time from JS, never SQLite.
 */
export function recordFire(fire: NewFire): void {
  transaction(() => {
    stmt("UPDATE reminders SET last_fired_at = ? WHERE id = ?").run(
      fire.firedAt.toISOString(),
      fire.reminderId,
    );
    stmt(
      `INSERT INTO reminder_fires (reminder_id, fired_on, fired_at, host_user_id, message_ts)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      fire.reminderId,
      fire.firedOn,
      fire.firedAt.toISOString(),
      fire.hostUserId,
      fire.messageTs,
    );
    writeLap(fire.reminderId, fire.nextLap);
  });
}

export function insertHoliday(holiday: Omit<Holiday, "addedAt">): void {
  stmt(`INSERT INTO holidays (date, added_by, added_in_channel, added_at) VALUES (?, ?, ?, ?)`).run(
    holiday.date,
    holiday.addedBy,
    holiday.addedInChannel,
    new Date().toISOString(),
  );
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

/** Hosted-first, then the pending lap in order — the shape `pendingLap` expects. */
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

/** Anyone in `userIds` but absent from `lap` is recorded as having already hosted it. */
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

export function getFireByMessageTs(messageTs: string): Fire | undefined {
  return stmt(`SELECT ${FIRE_COLUMNS} FROM reminder_fires WHERE message_ts = ?`).get(
    messageTs,
  ) as unknown as Fire | undefined;
}

/** Null when a handover found nobody available, which the post reports. */
export function setFireHost(fireId: number, hostUserId: string | null): void {
  stmt("UPDATE reminder_fires SET host_user_id = ? WHERE id = ?").run(hostUserId, fireId);
}

/** False when this person was already down as out, so callers can say so. */
export function addSkip(fireId: number, userId: string): boolean {
  const result = stmt(
    `INSERT OR IGNORE INTO reminder_skips (fire_id, user_id, created_at) VALUES (?, ?, ?)`,
  ).run(fireId, userId, new Date().toISOString());
  return result.changes > 0;
}

export function listSkips(fireId: number): string[] {
  const rows = stmt(
    "SELECT user_id AS userId FROM reminder_skips WHERE fire_id = ? ORDER BY created_at, user_id",
  ).all(fireId) as unknown as { userId: string }[];
  return rows.map((row) => row.userId);
}

export function lastHostedOn(reminderId: number): Map<string, string> {
  const rows = stmt(
    `SELECT host_user_id AS userId, MAX(fired_on) AS firedOn
       FROM reminder_fires
      WHERE reminder_id = ? AND host_user_id IS NOT NULL
      GROUP BY host_user_id`,
  ).all(reminderId) as unknown as { userId: string; firedOn: string }[];
  return new Map(rows.map((row) => [row.userId, row.firedOn]));
}
