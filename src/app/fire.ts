import type { WebClient } from "@slack/web-api";
import { daysBetween, localParts } from "../domain/clock.js";
import { drawLap, pendingLap } from "../domain/rotation.js";
import { cadenceOk, requiredDaysSinceLastFire } from "../domain/schedule.js";
import type { Reminder } from "../domain/types.js";
import { fallbackText, reminderBlocks, type ReminderPost } from "../slack/blocks.js";
import { getHoliday, listHosts, recordFire } from "../store/reminders.js";

export type FireOutcome =
  | { posted: true; host: string | undefined }
  | { posted: false; reason: string };

function cadenceReason(reminder: Reminder, today: string): string {
  const lastFiredDate = localParts(new Date(reminder.lastFiredAt!)).date;
  const elapsed = daysBetween(lastFiredDate, today);
  return `cadence, ${elapsed}d since last fire < ${requiredDaysSinceLastFire(reminder.everyNWeeks)}d required`;
}

/** The one path that posts a reminder, so `run` rehearses the tick, guards included. */
export async function fireReminder(reminder: Reminder, client: WebClient): Promise<FireOutcome> {
  const now = new Date();
  const { date } = localParts(now);

  const holiday = getHoliday(date);
  if (holiday) return { posted: false, reason: `holiday ${date} (added by <@${holiday.addedBy}>)` };

  if (!cadenceOk(reminder, date)) return { posted: false, reason: cadenceReason(reminder, date) };

  const roster = listHosts(reminder.id);
  const lap = pendingLap(roster);
  const host = lap[0];

  const post: ReminderPost = {
    code: reminder.code,
    body: reminder.message,
    bodyFormat: reminder.bodyFormat,
    host,
    outToday: [],
    skippable: roster.length > 0,
    windowClosed: false,
  };

  const posted = await client.chat.postMessage({
    channel: reminder.channelId,
    blocks: reminderBlocks(post),
    text: fallbackText(post),
  });

  // Only now, so a failed post never costs anyone their turn.
  const remaining = lap.slice(1);
  recordFire({
    reminderId: reminder.id,
    firedOn: date,
    firedAt: now,
    hostUserId: host ?? null,
    messageTs: posted.ts ?? null,
    nextLap: remaining.length > 0 ? remaining : drawLap(roster.map((member) => member.userId)),
  });

  return { posted: true, host };
}
