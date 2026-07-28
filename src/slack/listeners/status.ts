import type { App } from "@slack/bolt";
import { getLastTickAt } from "../../app/scheduler.js";
import { localParts } from "../../domain/clock.js";
import { nextFire } from "../../domain/schedule.js";
import { getAiUsageSummary } from "../../store/ai-usage.js";
import { listHolidayDates, listReminders } from "../../store/reminders.js";

const STATUS_LINE = "🐝 Bumblebee is online and reporting for duty. Roll out! ⚡️";

function formatUsage(): string {
  const { requests, promptTokens, completionTokens, totalTokens, since } = getAiUsageSummary();

  if (requests === 0) return "*AI usage:* no requests recorded yet.";

  return [
    "*AI usage*",
    `• requests: ${requests}`,
    `• tokens: ${totalTokens} (prompt ${promptTokens} / completion ${completionTokens})`,
    `• since: ${since}`,
  ].join("\n");
}

function formatReminders(channelId: string): string {
  const reminders = listReminders(channelId);
  if (reminders.length === 0) return "*Reminders:* none in this channel yet.";

  const holidays = listHolidayDates();
  const now = new Date();
  const upcoming = reminders
    .map((reminder) => ({ reminder, next: nextFire(reminder, now, (date) => holidays.has(date)) }))
    .filter((candidate) => candidate.next !== null)
    .sort((a, b) => a.next!.getTime() - b.next!.getTime())[0];

  const lines = ["*Reminders (this channel)*", `• ${reminders.length} in this channel`];

  if (upcoming) {
    const { date, time } = localParts(upcoming.next!);
    lines.push(`• next: \`${upcoming.reminder.code}\` at ${time} on ${date}`);
  }

  const lastTickAt = getLastTickAt();
  lines.push(`• last tick: ${lastTickAt ? localParts(lastTickAt).time : "not yet"}`);

  return lines.join("\n");
}

export function registerStatus(app: App): void {
  app.command("/bee-status", async ({ ack, command, respond, logger }) => {
    await ack();
    let body = STATUS_LINE;
    try {
      body += `\n\n${formatUsage()}`;
    } catch (error) {
      logger.error("Failed to read AI usage summary", error);
    }
    try {
      body += `\n\n${formatReminders(command.channel_id)}`;
    } catch (error) {
      logger.error("Failed to read reminder status", error);
    }
    await respond(body);
  });
}
