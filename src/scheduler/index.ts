import type { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import {
  getHoliday,
  listEnabledReminders,
  listHosts,
  recordFire,
  type Reminder,
} from "../db/reminders.js";
import { assertJakarta, daysBetween, localParts } from "./clock.js";
import { cadenceOk, matches, requiredDaysSinceLastFire } from "./next.js";
import { drawLap } from "./rotation.js";

const MS_PER_MINUTE = 60_000;
const JUST_AFTER_THE_MINUTE_MS = 61_000;

export interface FireContext {
  client: WebClient;
}

export type FireOutcome =
  | { posted: true; host: string | undefined }
  | { posted: false; reason: string };

let lastTickAt: Date | undefined;

export function getLastTickAt(): Date | undefined {
  return lastTickAt;
}

function cadenceReason(reminder: Reminder, today: string): string {
  const lastFiredDate = localParts(new Date(reminder.lastFiredAt!)).date;
  const elapsed = daysBetween(lastFiredDate, today);
  return `cadence, ${elapsed}d since last fire < ${requiredDaysSinceLastFire(reminder.everyNWeeks)}d required`;
}

/**
 * The one path that posts a reminder. `run` reuses it so a manual trigger
 * rehearses exactly what the tick does, guards included.
 */
export async function fireReminder(reminder: Reminder, ctx: FireContext): Promise<FireOutcome> {
  const now = new Date();
  const { date } = localParts(now);

  const holiday = getHoliday(date);
  if (holiday) return { posted: false, reason: `holiday ${date} (added by <@${holiday.addedBy}>)` };

  if (!cadenceOk(reminder, date)) return { posted: false, reason: cadenceReason(reminder, date) };

  const roster = listHosts(reminder.id);
  const lap = roster.filter((member) => member.lapOrder !== null).map((member) => member.userId);
  const host = lap[0];

  const posted = await ctx.client.chat.postMessage({
    channel: reminder.channelId,
    markdown_text: host ? `${reminder.message}\n🎙 Host: <@${host}>` : reminder.message,
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

async function runTick(app: App): Promise<void> {
  const now = new Date();
  const wallClock = localParts(now);
  lastTickAt = now;

  for (const reminder of listEnabledReminders()) {
    if (!matches(reminder, wallClock)) continue;

    try {
      const outcome = await fireReminder(reminder, app);
      if (outcome.posted) {
        const host = outcome.host ? ` (host ${outcome.host})` : "";
        app.logger.info(`fired \`${reminder.code}\` -> ${reminder.channelId}${host}`);
      } else {
        app.logger.info(`skipped \`${reminder.code}\`: ${outcome.reason}`);
      }
    } catch (error) {
      app.logger.error(`\`${reminder.code}\` failed to post to ${reminder.channelId}`, error);
    }
  }
}

export function startScheduler(app: App): void {
  assertJakarta(app.logger);

  let inTick = false;
  let lastStamp = "";

  const tick = async (): Promise<void> => {
    const { date, time } = localParts(new Date());
    const stamp = `${date} ${time}`;
    if (inTick || stamp === lastStamp) return;

    inTick = true;
    lastStamp = stamp;
    try {
      await runTick(app);
    } catch (error) {
      app.logger.error("scheduler tick failed", error);
    } finally {
      inTick = false;
    }
  };

  const scheduleNextTick = (): void => {
    setTimeout(() => {
      void tick().finally(scheduleNextTick);
    }, JUST_AFTER_THE_MINUTE_MS - (Date.now() % MS_PER_MINUTE));
  };

  scheduleNextTick();
}
