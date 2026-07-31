import type { App } from "@slack/bolt";
import { getLastTickAt } from "../../app/scheduler.js";
import { localParts } from "../../domain/clock.js";
import { nextCfFire, nextFire } from "../../domain/schedule.js";
import { listHolidayDates, listReminders } from "../../store/reminders.js";
import { getSchedule, listRepos } from "../../store/cf.js";
import { formatDays } from "../text.js";

const STATUS_LINE = "🐝 Bumblebee is online and reporting for duty. Roll out! ⚡️";

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

function formatCf(channelId: string): string {
  const repos = listRepos(channelId);
  const schedule = getSchedule(channelId);
  if (repos.length === 0 && !schedule) return "*Code Freeze:* not configured in this channel.";

  const lines = ["*Code Freeze (this channel)*", `• ${repos.length} repo(s) configured`];

  if (schedule) {
    lines.push(`• recurring: every ${formatDays(schedule.days)} at ${schedule.at} (Asia/Jakarta)`);
    const next = nextCfFire(schedule, new Date());
    if (next) lines.push(`• next: ${localParts(next).date} at ${localParts(next).time}`);
    if (schedule.lastFiredDate) lines.push(`• last run: ${schedule.lastFiredDate}`);
  } else {
    lines.push("• recurring: not configured");
  }

  return lines.join("\n");
}

export function registerStatus(app: App): void {
  app.command("/bee-status", async ({ ack, command, respond, logger }) => {
    await ack();
    let body = STATUS_LINE;
    try {
      body += `\n\n${formatReminders(command.channel_id)}`;
    } catch (error) {
      logger.error("Failed to read reminder status", error);
    }
    try {
      body += `\n\n${formatCf(command.channel_id)}`;
    } catch (error) {
      logger.error("Failed to read Code Freeze status", error);
    }
    await respond(body);
  });
}
