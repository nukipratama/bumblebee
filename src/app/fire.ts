import type { WebClient } from "@slack/web-api";
import { daysBetween, localParts } from "../domain/clock.js";
import { drawLap, pendingLap } from "../domain/rotation.js";
import { cadenceOk, requiredDaysSinceLastFire } from "../domain/schedule.js";
import type { Reminder } from "../domain/types.js";
import {
  fallbackText,
  type PostBody,
  reminderBlocks,
  reminderBody,
  type ReminderPost,
} from "../slack/blocks.js";
import {
  getFireForDate,
  getHoliday,
  listHosts,
  listSkips,
  recordFire,
  setJoinMessageTs,
} from "../store/reminders.js";

export type FireOutcome =
  | { posted: true; host: string | undefined }
  | { posted: false; reason: string };

function cadenceReason(reminder: Reminder, today: string): string {
  const lastFiredDate = localParts(new Date(reminder.lastFiredAt!)).date;
  const elapsed = daysBetween(lastFiredDate, today);
  return `cadence, ${elapsed}d since last fire < ${requiredDaysSinceLastFire(reminder.everyNWeeks)}d required`;
}

/**
 * The one path that posts a reminder, so `run` rehearses the tick, guards
 * included. `which` is the caller's: firing at `at` is the catch-up for a missed
 * lead time, and a heads-up once the meeting has started would read as a mistake.
 */
export async function fireReminder(
  reminder: Reminder,
  client: WebClient,
  which: PostBody,
): Promise<FireOutcome> {
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
    ...reminderBody(reminder, which),
    host,
    skips: [],
    skippable: roster.length > 0,
  };

  const posted = await client.chat.postMessage({
    channel: reminder.channelId,
    blocks: reminderBlocks(post),
    text: fallbackText(post),
    // A body is often just a meeting link, and the card outlives every update.
    unfurl_links: false,
    unfurl_media: false,
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

/**
 * The post at `at` for a reminder that already fired early. A missed lead time
 * leaves no fire to join, so this falls back to firing outright — the day loses
 * its heads-up, but nobody loses their turn.
 */
export async function postJoin(reminder: Reminder, client: WebClient): Promise<FireOutcome> {
  const { date } = localParts(new Date());

  const fire = getFireForDate(reminder.id, date);
  if (!fire) return fireReminder(reminder, client, "meeting");

  const hasRoster = listHosts(reminder.id).length > 0;

  // Read the host off the fire, never off the lap: a handover since the early
  // post has already moved it, and the lap has advanced past today either way.
  const post: ReminderPost = {
    code: reminder.code,
    ...reminderBody(reminder, "meeting"),
    host: fire.hostUserId ?? undefined,
    hostUnavailable: hasRoster && !fire.hostUserId,
    skips: listSkips(fire.id),
    skippable: hasRoster,
  };

  const posted = await client.chat.postMessage({
    channel: reminder.channelId,
    blocks: reminderBlocks(post),
    text: fallbackText(post),
    unfurl_links: false,
    unfurl_media: false,
  });

  if (posted.ts) setJoinMessageTs(fire.id, posted.ts);

  return { posted: true, host: fire.hostUserId ?? undefined };
}
