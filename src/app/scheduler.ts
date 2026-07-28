import type { App, Logger } from "@slack/bolt";
import { localParts } from "../domain/clock.js";
import { matches } from "../domain/schedule.js";
import { listAllReminders } from "../store/reminders.js";
import { fireReminder } from "./fire.js";

const MS_PER_MINUTE = 60_000;
const JUST_AFTER_THE_MINUTE_MS = 61_000;
const JAKARTA_UTC_OFFSET_MINUTES = 420;
const MINUTES_PER_HOUR = 60;

let lastTickAt: Date | undefined;

export function getLastTickAt(): Date | undefined {
  return lastTickAt;
}

function assertJakarta(logger: Logger): void {
  const offsetMinutes = -new Date().getTimezoneOffset();
  if (offsetMinutes === JAKARTA_UTC_OFFSET_MINUTES) return;

  logger.error(
    `TZ misconfigured: expected UTC+7 (Asia/Jakarta), got ` +
      `UTC${offsetMinutes >= 0 ? "+" : ""}${offsetMinutes / MINUTES_PER_HOUR}. ` +
      `Reminders will fire at the wrong time. ` +
      `Check that the image has tzdata installed and TZ=Asia/Jakarta is set.`,
  );
}

async function runTick(app: App): Promise<void> {
  const now = new Date();
  const wallClock = localParts(now);
  lastTickAt = now;

  for (const reminder of listAllReminders()) {
    if (!matches(reminder, wallClock)) continue;

    try {
      const outcome = await fireReminder(reminder, app.client);
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
