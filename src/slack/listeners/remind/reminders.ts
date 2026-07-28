import { CODE_RULE, isReminderCode } from "../../../domain/code.js";
import { EVERY_DAY } from "../../../domain/days.js";
import { fail, ok, type Parsed } from "../../../domain/result.js";
import { cadenceFitsDays } from "../../../domain/schedule.js";
import type { Reminder, ReminderChanges } from "../../../domain/types.js";
import {
  getReminder,
  lastHostedOn,
  listHolidayDates,
  listHosts,
  listReminders,
} from "../../../store/reminders.js";
import {
  CADENCE_FLAGS,
  parseAt,
  parseCadence,
  parseDays,
  normalizeMentions,
  unescapeNewlines,
  type Args,
} from "../../args.js";
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

function readChanges(args: Args): Parsed<ReminderChanges> {
  const changes: ReminderChanges = {};

  const at = args.flags.get("at");
  if (typeof at === "string") {
    const parsed = parseAt(at);
    if (!parsed.ok) return parsed;
    changes.at = parsed.value;
  }

  const on = args.flags.get("on");
  if (typeof on === "string") {
    const parsed = parseDays(on);
    if (!parsed.ok) return parsed;
    changes.days = parsed.value;
  }

  const message = args.flags.get("message");
  if (typeof message === "string") {
    if (message.trim() === "") return fail("`--message` cannot be empty");
    changes.message = normalizeMentions(unescapeNewlines(message));
  }

  const cadence = parseCadence(args.flags);
  if (!cadence.ok) return cadence;
  if ([...CADENCE_FLAGS.keys()].some((flag) => args.flags.has(flag))) {
    changes.everyNWeeks = cadence.value;
  }

  return ok(changes);
}

export async function handleAdd(ctx: CommandContext, args: Args): Promise<void> {
  const code = await unwrap(ctx, readCode(args));
  if (code === undefined) return;
  if (!isReminderCode(code)) {
    await ctx.respond(`\`${code}\` must be ${CODE_RULE}`);
    return;
  }
  if (getReminder(ctx.channelId, code)) {
    await ctx.respond(`\`${code}\` already exists in this channel`);
    return;
  }

  const changes = await unwrap(ctx, readChanges(args));
  if (changes === undefined) return;

  const { at, message } = changes;
  if (!at) {
    await ctx.respond("`--at HH:MM` is required");
    return;
  }
  if (!message) {
    await ctx.respond('`--message "…"` is required');
    return;
  }

  const days = changes.days ?? EVERY_DAY;
  const everyNWeeks = changes.everyNWeeks ?? 1;
  if ((await unwrap(ctx, cadenceFitsDays(everyNWeeks, days))) === undefined) return;

  await ctx.ask(
    [
      `Add reminder \`${code}\`?`,
      `*When*  ${formatSchedule({ at, days, everyNWeeks })}`,
      `*Message*\n${message}`,
      "",
      "_If I'm not in this channel yet, run `/invite @Bumblebee` or I can't post._",
    ].join("\n"),
    {
      kind: "add",
      reminder: {
        channelId: ctx.channelId,
        code,
        at,
        days,
        message,
        bodyFormat: "markdown",
        everyNWeeks,
        createdBy: ctx.userId,
      },
    },
  );
}

export async function handleEdit(ctx: CommandContext, args: Args): Promise<void> {
  const code = await unwrap(ctx, readCode(args));
  if (code === undefined) return;

  const existing = await unwrap(ctx, requireReminder(ctx.channelId, code));
  if (existing === undefined) return;

  const changes = await unwrap(ctx, readChanges(args));
  if (changes === undefined) return;
  if (Object.keys(changes).length === 0) {
    await ctx.respond("nothing to change — pass `--at`, `--on`, `--message` or a cadence flag");
    return;
  }

  const merged = { ...existing, ...changes };
  if ((await unwrap(ctx, cadenceFitsDays(merged.everyNWeeks, merged.days))) === undefined) return;

  const lines = [
    `Edit reminder \`${code}\`?`,
    `*Now*    ${formatSchedule(existing)}`,
    `*After*  ${formatSchedule(merged)}`,
  ];
  if (changes.message) lines.push(`*New message*\n${changes.message}`);

  await ctx.ask(lines.join("\n"), { kind: "edit", code, changes });
}

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
  const reminders = listReminders(ctx.channelId);
  if (reminders.length === 0) {
    await ctx.respond("No reminders in this channel yet. `/bee-remind help` to get started.");
    return;
  }

  const lines = reminders.map(
    (reminder) => `\`${reminder.at}\`  \`${reminder.code}\`  ${formatRecurrence(reminder)}`,
  );

  await ctx.respond(["*Reminders in this channel*", ...lines].join("\n"));
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
