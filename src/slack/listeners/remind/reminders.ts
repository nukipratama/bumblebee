import { localParts } from "../../../domain/clock.js";
import {
  getFireForDate,
  lastHostedOn,
  listHolidayDates,
  listHosts,
  listReminders,
} from "../../../store/reminders.js";
import { reminderDetailBlocks, reminderListBlocks } from "../../blocks.js";
import {
  formatHeadsUp,
  formatNextFire,
  formatRecurrence,
  formatRotation,
  formatSchedule,
  formatTimestamp,
  mention,
} from "../../text.js";
import { readCode, requireReminder, unwrap, type CommandContext } from "./context.js";

export async function handleList(ctx: CommandContext): Promise<void> {
  const rows = listReminders(ctx.channelId).map((reminder) => ({
    code: reminder.code,
    at: reminder.at,
    recurrence: formatRecurrence(reminder),
  }));

  await ctx.respond("Reminders in this channel", reminderListBlocks(rows));
}

export async function handleShow(ctx: CommandContext, rest: string): Promise<void> {
  const code = await unwrap(ctx, readCode(rest));
  if (code === undefined) return;

  const reminder = await unwrap(ctx, requireReminder(ctx.channelId, code));
  if (reminder === undefined) return;

  const rotation = formatRotation(listHosts(reminder.id), lastHostedOn(reminder.id));
  const firedToday = Boolean(getFireForDate(reminder.id, localParts(new Date()).date));
  const headsUp = formatHeadsUp(reminder);
  const body = [
    `*\`${reminder.code}\`*`,
    `*schedule*  ${formatSchedule(reminder)}`,
    ...(headsUp ? [`*heads-up*  ${headsUp}`] : []),
    `*created*  ${mention(reminder.createdBy)} on ${formatTimestamp(reminder.createdAt)}`,
    `*last fired*  ${formatTimestamp(reminder.lastFiredAt)}`,
    `*next fire*  ${formatNextFire(reminder, listHolidayDates())}`,
    "",
    "*message*",
    reminder.message,
    ...(reminder.preMessage ? ["", "*heads-up message*", reminder.preMessage] : []),
  ].join("\n");

  await ctx.respond(
    `${reminder.code} — ${formatSchedule(reminder)}`,
    reminderDetailBlocks({ code: reminder.code, body, rotation, firedToday }),
  );
}
