import type { App, BlockAction, ButtonAction, Logger } from "@slack/bolt";
import type { KnownBlock, WebClient } from "@slack/web-api";
import {
  deleteHoliday,
  deleteReminder,
  getHoliday,
  getReminder,
  insertHoliday,
  insertReminder,
  listHolidayDates,
  listHolidays,
  listReminders,
  setReminderAt,
  setReminderCadence,
  setReminderDays,
  setReminderEnabled,
  setReminderMessage,
  type Reminder,
} from "../db/reminders.js";
import { localParts } from "../scheduler/clock.js";
import { fireReminder } from "../scheduler/index.js";
import { nextFire } from "../scheduler/next.js";
import {
  CADENCE_FLAGS,
  normalizeMentions,
  parseArgs,
  parseAt,
  parseCadence,
  parseDate,
  parseDays,
  unescapeNewlines,
  type Args,
  type FlagSpec,
  type Parsed,
} from "./args.js";
import {
  put,
  takeIfFreshAndOwnedBy,
  type PendingAction,
  type PendingEntry,
  type ReminderChanges,
} from "./pending.js";

const APPROVE = "remind_approve";
const REJECT = "remind_reject";
const CODE_PATTERN = /^[a-z0-9-]+$/;
const WEEKDAYS = "monday,tuesday,wednesday,thursday,friday";
const EVERY_DAY = "*";
const HOLIDAYS_ARE_SHARED = "_Holidays are shared — they skip reminders in every channel._";

const FLAG_SPEC: FlagSpec = {
  withValue: ["at", "on", "message"],
  boolean: [...CADENCE_FLAGS.keys()],
};

interface CommandContext {
  channelId: string;
  userId: string;
  respond: (text: string) => Promise<unknown>;
  ask: (summary: string, action: PendingAction) => Promise<void>;
}

function formatDays(days: string): string {
  if (days === EVERY_DAY) return "daily";
  if (days === WEEKDAYS) return "weekdays";
  return days.replaceAll(",", ", ");
}

function formatCadence(everyNWeeks: number): string {
  return everyNWeeks === 1 ? "every week" : `every ${everyNWeeks} weeks`;
}

function formatRecurrence(reminder: Pick<Reminder, "days" | "everyNWeeks">): string {
  const cadence = reminder.everyNWeeks === 1 ? "" : ` · ${formatCadence(reminder.everyNWeeks)}`;
  return `${formatDays(reminder.days)}${cadence}`;
}

function formatSchedule(reminder: Pick<Reminder, "at" | "days" | "everyNWeeks">): string {
  return `${reminder.at} · ${formatRecurrence(reminder)}`;
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "never";
  const { date, time } = localParts(new Date(iso));
  return `${date} ${time}`;
}

function formatNextFire(reminder: Reminder): string {
  if (!reminder.enabled) return "paused";
  const holidays = listHolidayDates();
  const next = nextFire(reminder, new Date(), (date) => holidays.has(date));
  return next ? formatTimestamp(next.toISOString()) : "nothing in the next 4 weeks";
}

function confirmBlocks(summary: string, pendingId: string): KnownBlock[] {
  return [
    { type: "section", text: { type: "mrkdwn", text: summary } },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: APPROVE,
          style: "primary",
          text: { type: "plain_text", text: "Approve" },
          value: pendingId,
        },
        {
          type: "button",
          action_id: REJECT,
          style: "danger",
          text: { type: "plain_text", text: "Reject" },
          value: pendingId,
        },
      ],
    },
  ];
}

function helpText(): string {
  return [
    "*`/bee-remind`* — scheduled reminders for this channel. Every change asks you to confirm first.",
    "",
    "*Reminders*",
    '• `add <code> --at HH:MM --message "…" [--on <days>] [--every-2-week|--every-3-week]`',
    "• `list` · `show <code>` · `edit <code> --…` · `pause <code>` · `resume <code>`",
    "• `remove <code>` · `run <code>` — `run` posts now, still respecting holidays and cadence",
    "",
    "*Holidays* — shared across every channel",
    "• `holiday add <YYYY-MM-DD>` · `holiday list` · `holiday remove <YYYY-MM-DD>`",
    "",
    "*Notes*",
    "• `--on` takes `daily` or full day names: `monday,wednesday`. Defaults to `daily`.",
    "• Times are 24-hour, Asia/Jakarta.",
    "• Use `\\n` in `--message` for a line break, and type `@someone` to mention them.",
  ].join("\n");
}

function requireReminder(channelId: string, code: string): Parsed<Reminder> {
  const reminder = getReminder(channelId, code);
  return reminder
    ? { ok: true, value: reminder }
    : { ok: false, error: `no reminder \`${code}\` in this channel` };
}

/** Unwraps a `Parsed<T>`, responding with the error and returning undefined on failure. */
async function unwrap<T>(ctx: CommandContext, parsed: Parsed<T>): Promise<T | undefined> {
  if (parsed.ok) return parsed.value;
  await ctx.respond(parsed.error);
  return undefined;
}

function readCode(args: Args): Parsed<string> {
  if (args.positionals.length > 1) {
    const extra = args.positionals.slice(1).join(" ");
    return { ok: false, error: `unexpected \`${extra}\` — quote the message with \`"…"\`` };
  }

  const code = args.positionals[0];
  if (!code) return { ok: false, error: "a code is required, like `standup`" };
  return { ok: true, value: code };
}

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
    if (message.trim() === "") return { ok: false, error: "`--message` cannot be empty" };
    changes.message = normalizeMentions(unescapeNewlines(message));
  }

  const cadence = parseCadence(args.flags);
  if (!cadence.ok) return cadence;
  if ([...CADENCE_FLAGS.keys()].some((flag) => args.flags.has(flag))) {
    changes.everyNWeeks = cadence.value;
  }

  return { ok: true, value: changes };
}

function cadenceFitsDays(everyNWeeks: number, days: string): Parsed<true> {
  const singleDay = days !== EVERY_DAY && !days.includes(",");
  if (everyNWeeks === 1 || singleDay) return { ok: true, value: true };

  return {
    ok: false,
    error:
      `${formatCadence(everyNWeeks)} needs exactly one day in \`--on\` — the gap is measured ` +
      "in days, so several days would post once per cycle rather than on each day",
  };
}

async function handleAdd(ctx: CommandContext, args: Args): Promise<void> {
  const code = await unwrap(ctx, readCode(args));
  if (code === undefined) return;
  if (!CODE_PATTERN.test(code)) {
    await ctx.respond(`\`${code}\` must be lowercase letters, numbers or dashes`);
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
      reminder: { channelId: ctx.channelId, code, at, days, message, everyNWeeks, createdBy: ctx.userId },
    },
  );
}

async function handleEdit(ctx: CommandContext, args: Args): Promise<void> {
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

async function handleForExisting(
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

async function handleList(ctx: CommandContext): Promise<void> {
  const reminders = listReminders(ctx.channelId);
  if (reminders.length === 0) {
    await ctx.respond("No reminders in this channel yet. `/bee-remind help` to get started.");
    return;
  }

  const lines = reminders.map((reminder) => {
    const paused = reminder.enabled ? "" : "  ⏸ paused";
    return `\`${reminder.at}\`  \`${reminder.code}\`  ${formatRecurrence(reminder)}${paused}`;
  });

  await ctx.respond(["*Reminders in this channel*", ...lines].join("\n"));
}

async function handleShow(ctx: CommandContext, args: Args): Promise<void> {
  const code = await unwrap(ctx, readCode(args));
  if (code === undefined) return;

  const reminder = await unwrap(ctx, requireReminder(ctx.channelId, code));
  if (reminder === undefined) return;

  await ctx.respond(
    [
      `*\`${reminder.code}\`*`,
      `*schedule*  ${formatSchedule(reminder)}`,
      `*state*  ${reminder.enabled ? "active" : "paused"}`,
      `*created*  <@${reminder.createdBy}> on ${formatTimestamp(reminder.createdAt)}`,
      `*last fired*  ${formatTimestamp(reminder.lastFiredAt)}`,
      `*next fire*  ${formatNextFire(reminder)}`,
      "",
      "*message*",
      reminder.message,
    ].join("\n"),
  );
}

async function handleHolidayList(ctx: CommandContext): Promise<void> {
  const holidays = listHolidays();
  const lines = holidays.map(
    (holiday) =>
      `• \`${holiday.date}\` — added by <@${holiday.addedBy}> in <#${holiday.addedInChannel}>`,
  );
  const body = holidays.length === 0 ? "No holidays recorded." : ["*Holidays*", ...lines].join("\n");
  await ctx.respond(`${body}\n\n${HOLIDAYS_ARE_SHARED}`);
}

async function handleHolidayAdd(ctx: CommandContext, date: string): Promise<void> {
  const existing = getHoliday(date);
  if (existing) {
    await ctx.respond(
      `\`${date}\` is already a holiday — added by <@${existing.addedBy}> in <#${existing.addedInChannel}>`,
    );
    return;
  }
  if (date < localParts(new Date()).date) {
    await ctx.respond(`\`${date}\` is in the past, so it can't skip anything`);
    return;
  }

  await ctx.ask(`Add holiday \`${date}\`?\n${HOLIDAYS_ARE_SHARED}`, { kind: "holidayAdd", date });
}

async function handleHolidayRemove(ctx: CommandContext, date: string): Promise<void> {
  if (!getHoliday(date)) {
    await ctx.respond(`\`${date}\` is not a holiday`);
    return;
  }

  await ctx.ask(`Remove holiday \`${date}\`?\n${HOLIDAYS_ARE_SHARED}`, {
    kind: "holidayRemove",
    date,
  });
}

async function handleHoliday(ctx: CommandContext, rest: string): Promise<void> {
  const [action = "", value = ""] = rest.trim().split(/\s+/);

  if (action === "list") {
    await handleHolidayList(ctx);
    return;
  }
  if (action !== "add" && action !== "remove") {
    await ctx.respond("`holiday add <YYYY-MM-DD>`, `holiday list` or `holiday remove <YYYY-MM-DD>`");
    return;
  }

  const date = await unwrap(ctx, parseDate(value));
  if (date === undefined) return;

  if (action === "add") await handleHolidayAdd(ctx, date);
  else await handleHolidayRemove(ctx, date);
}

interface ApplyResult {
  ephemeral: string;
  channel?: string;
}

function applyAdd(entry: PendingEntry, reminder: Reminder | undefined): ApplyResult {
  const action = entry.action as Extract<PendingAction, { kind: "add" }>;
  if (reminder) return { ephemeral: `\`${action.reminder.code}\` already exists now — nothing added` };

  insertReminder(action.reminder);
  return {
    ephemeral: `Added \`${action.reminder.code}\`.`,
    channel: `<@${entry.userId}> added reminder \`${action.reminder.code}\` — ${formatSchedule(action.reminder)}`,
  };
}

function applyEdit(entry: PendingEntry, existing: Reminder | undefined): ApplyResult {
  const action = entry.action as Extract<PendingAction, { kind: "edit" }>;
  if (!existing) return { ephemeral: `\`${action.code}\` no longer exists — nothing changed` };

  const merged = { ...existing, ...action.changes };
  const fits = cadenceFitsDays(merged.everyNWeeks, merged.days);
  if (!fits.ok) {
    return {
      ephemeral: `\`${action.code}\` changed since you asked — ${fits.error}. Nothing changed; run \`edit\` again.`,
    };
  }

  const { at, days, message, everyNWeeks } = action.changes;
  if (at !== undefined) setReminderAt(entry.channelId, action.code, at);
  if (days !== undefined) setReminderDays(entry.channelId, action.code, days);
  if (message !== undefined) setReminderMessage(entry.channelId, action.code, message);
  if (everyNWeeks !== undefined) setReminderCadence(entry.channelId, action.code, everyNWeeks);

  const updated = getReminder(entry.channelId, action.code)!;
  return {
    ephemeral: `Updated \`${action.code}\`.`,
    channel: `<@${entry.userId}> edited reminder \`${action.code}\` — now ${formatSchedule(updated)}`,
  };
}

function applyRemove(entry: PendingEntry, existing: Reminder | undefined, code: string): ApplyResult {
  if (!existing) return { ephemeral: `\`${code}\` no longer exists — nothing removed` };

  deleteReminder(entry.channelId, code);
  return {
    ephemeral: `Removed \`${code}\`.`,
    channel: `<@${entry.userId}> removed reminder \`${code}\``,
  };
}

function applySetEnabled(
  entry: PendingEntry,
  existing: Reminder | undefined,
  code: string,
  enabled: boolean,
): ApplyResult {
  if (!existing) return { ephemeral: `\`${code}\` no longer exists — nothing changed` };

  setReminderEnabled(entry.channelId, code, enabled);
  const verb = enabled ? "resumed" : "paused";
  return {
    ephemeral: `Reminder \`${code}\` ${verb}.`,
    channel: `<@${entry.userId}> ${verb} reminder \`${code}\``,
  };
}

async function applyRun(
  existing: Reminder | undefined,
  code: string,
  client: WebClient,
): Promise<ApplyResult> {
  if (!existing) return { ephemeral: `\`${code}\` no longer exists — nothing posted` };

  const outcome = await fireReminder(existing, { client });
  if (outcome.posted) return { ephemeral: `Posted \`${code}\`.` };

  const whenNext = existing.enabled ? `\nNext fire: ${formatNextFire(existing)}` : "";
  return { ephemeral: `Skipped \`${code}\`: ${outcome.reason}.${whenNext}` };
}

function applyHolidayAdd(entry: PendingEntry, date: string): ApplyResult {
  if (getHoliday(date)) return { ephemeral: `\`${date}\` is already a holiday` };

  insertHoliday({ date, addedBy: entry.userId, addedInChannel: entry.channelId });
  return {
    ephemeral: `Added holiday \`${date}\`.`,
    channel: `<@${entry.userId}> added holiday \`${date}\` — reminders skip it in every channel`,
  };
}

function applyHolidayRemove(entry: PendingEntry, date: string): ApplyResult {
  if (!getHoliday(date)) return { ephemeral: `\`${date}\` is not a holiday` };

  deleteHoliday(date);
  return {
    ephemeral: `Removed holiday \`${date}\`.`,
    channel: `<@${entry.userId}> removed holiday \`${date}\``,
  };
}

/** Re-reads current state, because it can change between the prompt and the click. */
async function applyAction(entry: PendingEntry, client: WebClient): Promise<ApplyResult> {
  const { action, channelId } = entry;

  switch (action.kind) {
    case "add":
      return applyAdd(entry, getReminder(channelId, action.reminder.code));
    case "edit":
      return applyEdit(entry, getReminder(channelId, action.code));
    case "remove":
      return applyRemove(entry, getReminder(channelId, action.code), action.code);
    case "setEnabled":
      return applySetEnabled(entry, getReminder(channelId, action.code), action.code, action.enabled);
    case "run":
      return applyRun(getReminder(channelId, action.code), action.code, client);
    case "holidayAdd":
      return applyHolidayAdd(entry, action.date);
    case "holidayRemove":
      return applyHolidayRemove(entry, action.date);
  }
}

async function dispatch(ctx: CommandContext, text: string): Promise<void> {
  const trimmed = text.trim();
  const boundary = trimmed.indexOf(" ");
  const subcommand = boundary === -1 ? trimmed : trimmed.slice(0, boundary);
  const rest = boundary === -1 ? "" : trimmed.slice(boundary + 1);

  if (subcommand === "" || subcommand === "help") {
    await ctx.respond(helpText());
    return;
  }
  if (subcommand === "holiday") {
    await handleHoliday(ctx, rest);
    return;
  }
  if (subcommand === "list") {
    await handleList(ctx);
    return;
  }

  const args = await unwrap(ctx, parseArgs(rest, FLAG_SPEC));
  if (args === undefined) return;

  switch (subcommand) {
    case "add":
      return handleAdd(ctx, args);
    case "edit":
      return handleEdit(ctx, args);
    case "show":
      return handleShow(ctx, args);
    case "pause":
      return handleForExisting(ctx, args, (reminder) => ({
        summary: `Pause \`${reminder.code}\`? It stops firing until you resume it.`,
        action: { kind: "setEnabled", code: reminder.code, enabled: false },
      }));
    case "resume":
      return handleForExisting(ctx, args, (reminder) => ({
        summary: `Resume \`${reminder.code}\`? It fires again at ${formatSchedule(reminder)}.`,
        action: { kind: "setEnabled", code: reminder.code, enabled: true },
      }));
    case "remove":
      return handleForExisting(ctx, args, (reminder) => ({
        summary: `Remove \`${reminder.code}\`?  ${formatSchedule(reminder)}\nThis cannot be undone.`,
        action: { kind: "remove", code: reminder.code },
      }));
    case "run":
      return handleForExisting(ctx, args, (reminder) => ({
        summary: `Post \`${reminder.code}\` to this channel now?\n\n${reminder.message}`,
        action: { kind: "run", code: reminder.code },
      }));
    default:
      await ctx.respond(`unknown subcommand \`${subcommand}\` — try \`/bee-remind help\``);
  }
}

interface ConfirmationArgs {
  approved: boolean;
  body: BlockAction<ButtonAction>;
  respond: (message: { text: string; replace_original: true }) => Promise<unknown>;
  client: WebClient;
  logger: Logger;
}

async function resolveConfirmation({
  approved,
  body,
  respond,
  client,
  logger,
}: ConfirmationArgs): Promise<void> {
  const pendingId = body.actions[0]?.value;
  const entry = pendingId ? takeIfFreshAndOwnedBy(pendingId, body.user.id) : undefined;

  if (!entry) {
    await respond({
      replace_original: true,
      text: "That confirmation expired — run the command again.",
    });
    return;
  }

  if (!approved) {
    await respond({ replace_original: true, text: "Cancelled — nothing changed." });
    return;
  }

  try {
    const result = await applyAction(entry, client);
    await respond({ replace_original: true, text: result.ephemeral });
    if (result.channel) {
      await client.chat.postMessage({ channel: entry.channelId, text: result.channel });
    }
  } catch (error) {
    logger.error("confirmation failed to apply", error);
    await respond({ replace_original: true, text: "That didn't work. Check the logs." });
  }
}

export function registerRemind(app: App): void {
  app.command("/bee-remind", async ({ ack, command, respond, logger }) => {
    await ack();

    if (command.channel_id.startsWith("D")) {
      await respond("Use `/bee-remind` in a channel — reminders belong to a channel.");
      return;
    }

    const ctx: CommandContext = {
      channelId: command.channel_id,
      userId: command.user_id,
      respond: (text) => respond(text),
      ask: async (summary, action) => {
        const pendingId = put({
          action,
          userId: command.user_id,
          channelId: command.channel_id,
        });
        await respond({ text: summary, blocks: confirmBlocks(summary, pendingId) });
      },
    };

    try {
      await dispatch(ctx, command.text ?? "");
    } catch (error) {
      logger.error("/bee-remind failed", error);
      await respond("Something went wrong. Check the logs.");
    }
  });

  app.action<BlockAction<ButtonAction>>(APPROVE, async ({ ack, body, respond, client, logger }) => {
    await ack();
    await resolveConfirmation({ approved: true, body, respond, client, logger });
  });

  app.action<BlockAction<ButtonAction>>(REJECT, async ({ ack, body, respond, client, logger }) => {
    await ack();
    await resolveConfirmation({ approved: false, body, respond, client, logger });
  });
}
