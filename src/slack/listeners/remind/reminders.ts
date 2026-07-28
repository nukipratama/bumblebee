import type { Reminder } from "../../../domain/types.js";
import {
  lastHostedOn,
  listHolidayDates,
  listHosts,
  listReminders,
} from "../../../store/reminders.js";
import type { Args } from "../../args.js";
import { reminderListBlocks } from "../../blocks.js";
import type { PendingAction } from "../../pending.js";
import {
  formatNextFire,
  formatRecurrence,
  formatRotation,
  formatSchedule,
  formatTimestamp,
  mention,
} from "../../text.js";
import { readCode, requireReminder, unwrap, type CommandContext } from "./context.js";

export async function handleForExisting(
  ctx: CommandContext,
  args: Args,
  build: (reminder: Reminder) => { summary: string; action: PendingAction },
): Promise<void> {
  const code = await unwrap(ctx, readCode(args));
  if (code === undefined) return;

  const existing = await unwrap(ctx, requireReminder(ctx.channelId, code));
  if (existing === undefined) return;

  const { summary, action } = build(existing);
  await ctx.ask(summary, action);
}

export async function handleList(ctx: CommandContext): Promise<void> {
  const rows = listReminders(ctx.channelId).map((reminder) => ({
    code: reminder.code,
    at: reminder.at,
    recurrence: formatRecurrence(reminder),
  }));

  await ctx.respond("Reminders in this channel", reminderListBlocks(rows));
}

export async function handleShow(ctx: CommandContext, args: Args): Promise<void> {
  const code = await unwrap(ctx, readCode(args));
  if (code === undefined) return;

  const reminder = await unwrap(ctx, requireReminder(ctx.channelId, code));
  if (reminder === undefined) return;

  const rotation = formatRotation(listHosts(reminder.id), lastHostedOn(reminder.id));

  await ctx.respond(
    [
      `*\`${reminder.code}\`*`,
      `*schedule*  ${formatSchedule(reminder)}`,
      `*created*  ${mention(reminder.createdBy)} on ${formatTimestamp(reminder.createdAt)}`,
      `*last fired*  ${formatTimestamp(reminder.lastFiredAt)}`,
      `*next fire*  ${formatNextFire(reminder, listHolidayDates())}`,
      "",
      "*message*",
      reminder.message,
      ...(rotation ? ["", rotation] : []),
    ].join("\n"),
  );
}
