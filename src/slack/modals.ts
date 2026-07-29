import type { ViewStateValue } from "@slack/bolt";
import type { KnownBlock, View } from "@slack/web-api";
import { CODE_RULE, isReminderCode } from "../domain/code.js";
import { DAY_NAMES, EVERY_DAY, WEEKDAYS, daysColumn, daysToSelection, isEveryDay } from "../domain/days.js";
import { fail, ok, type Parsed } from "../domain/result.js";
import { sameRoster } from "../domain/rotation.js";
import { cadenceFitsDays, leadFitsBeforeMidnight } from "../domain/schedule.js";
import type { Host, Reminder, Skip } from "../domain/types.js";

export const REMINDER_FORM = "remind_form";

const DEFAULT_TIME = "09:00";
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const LEAD_PATTERN = /^\d{1,4}$/;
const NO_LEAD = 0;

export function parseAt(value: string): Parsed<string> {
  return TIME_PATTERN.test(value)
    ? ok(value)
    : fail(`\`${value}\` is not a 24-hour time — use HH:MM, like \`09:00\` or \`16:30\``);
}

/** An empty box is no heads-up, which is what every reminder had before. */
export function parseLead(value: string | undefined): Parsed<number> {
  if (value === undefined || value === "") return ok(NO_LEAD);

  return LEAD_PATTERN.test(value)
    ? ok(Number(value))
    : fail(`\`${value}\` is not a number of minutes — use digits, like \`55\``);
}

/** All seven days is the daily marker, not a list of seven. */
export function daysFromSelection(dayNames: readonly string[]): Parsed<string> {
  if (dayNames.length === 0) return fail("pick at least one day");

  const chosen = new Set(dayNames);
  return ok(isEveryDay(chosen) ? EVERY_DAY : daysColumn(chosen));
}

/**
 * Which reminder the form is for, round-tripped through `private_metadata`.
 * Kept small — the field caps at 3000 characters, so it points at a reminder
 * rather than carrying one.
 */
export type FormSource =
  | { kind: "fromMessage"; channelId: string; messageTs: string }
  | { kind: "create"; channelId: string }
  | { kind: "edit"; channelId: string; code: string };

const titleCase = (day: string): string => day[0]!.toUpperCase() + day.slice(1);

const dayOption = (day: string) => ({
  text: { type: "plain_text" as const, text: titleCase(day) },
  value: day,
});

const CADENCE_OPTIONS = [1, 2, 3].map((weeks) => ({
  text: {
    type: "plain_text" as const,
    text: weeks === 1 ? "Every week" : `Every ${weeks} weeks`,
  },
  value: String(weeks),
}));

const codeInput = (initialValue: string): KnownBlock => ({
  type: "input",
  block_id: "code",
  label: { type: "plain_text", text: "Name" },
  hint: { type: "plain_text", text: "How you'll refer to it: /bee-remind show <name>" },
  element: {
    type: "plain_text_input",
    action_id: "value",
    initial_value: initialValue,
  },
});

/** A name is the key a reminder is looked up by, so editing one would be a rename, not an edit. */
const codeDisplay = (code: string): KnownBlock => ({
  type: "context",
  elements: [{ type: "mrkdwn", text: `Editing \`${code}\`` }],
});

function messageInput(reminder?: Reminder): KnownBlock {
  const capturedFromMessage = reminder?.bodyFormat === "mrkdwn";
  return {
    type: "input",
    block_id: "message",
    label: { type: "plain_text", text: "Message" },
    hint: {
      type: "plain_text",
      // Retyping a captured body makes it Markdown, where `*word*` is italic
      // rather than bold. Leaving it untouched keeps it as it was written.
      // A modal returns plain text, so "@someone" typed here stays literal —
      // unlike the slash command, where Slack escaped it into a real mention.
      text: capturedFromMessage
        ? "Captured from a Slack message. Change the text and it is saved as Markdown."
        : "Posted as written. Typed @names are plain text, not mentions.",
    },
    element: {
      type: "plain_text_input",
      action_id: "value",
      multiline: true,
      ...(reminder ? { initial_value: reminder.message } : {}),
    },
  };
}

function scheduleInputs(reminder?: Reminder, roster: readonly Host[] = []): KnownBlock[] {
  const selected = reminder ? daysToSelection(reminder.days) : WEEKDAYS;
  const cadence = CADENCE_OPTIONS.find(
    (option) => option.value === String(reminder?.everyNWeeks ?? 1),
  );

  return [
    {
      type: "input",
      block_id: "at",
      label: { type: "plain_text", text: "Time" },
      // Slack's timepicker offers no way to set the dropdown's increments, and
      // its free-text entry is not discoverable, so the time is typed outright.
      hint: { type: "plain_text", text: "24-hour, Asia/Jakarta — e.g. 09:15" },
      element: {
        type: "plain_text_input",
        action_id: "value",
        initial_value: reminder?.at ?? DEFAULT_TIME,
        placeholder: { type: "plain_text", text: "09:15" },
      },
    },
    {
      type: "input",
      block_id: "lead",
      optional: true,
      label: { type: "plain_text", text: "Heads-up" },
      hint: {
        type: "plain_text",
        text: "Minutes before the time above. Leave empty for none. The host is picked then, so a handover can happen before the meeting.",
      },
      element: {
        type: "plain_text_input",
        action_id: "value",
        placeholder: { type: "plain_text", text: "55" },
        ...(reminder && reminder.leadMinutes > 0
          ? { initial_value: String(reminder.leadMinutes) }
          : {}),
      },
    },
    {
      type: "input",
      block_id: "preMessage",
      optional: true,
      label: { type: "plain_text", text: "Heads-up message" },
      hint: {
        type: "plain_text",
        text: "What the early post says. Required once a heads-up is set.",
      },
      element: {
        type: "plain_text_input",
        action_id: "value",
        multiline: true,
        ...(reminder?.preMessage ? { initial_value: reminder.preMessage } : {}),
      },
    },
    {
      type: "input",
      block_id: "days",
      label: { type: "plain_text", text: "Days" },
      element: {
        type: "checkboxes",
        action_id: "value",
        options: DAY_NAMES.map(dayOption),
        initial_options: selected.map(dayOption),
      },
    },
    {
      type: "input",
      block_id: "cadence",
      label: { type: "plain_text", text: "Repeat" },
      element: {
        type: "static_select",
        action_id: "value",
        options: CADENCE_OPTIONS,
        ...(cadence ? { initial_option: cadence } : {}),
      },
    },
    {
      type: "input",
      block_id: "hosts",
      optional: true,
      label: { type: "plain_text", text: "Host rotation" },
      hint: {
        type: "plain_text",
        text: "Leave empty for no rotation. Order is shuffled; nobody repeats until everyone has hosted.",
      },
      element: {
        type: "multi_users_select",
        action_id: "value",
        ...(roster.length > 0 ? { initial_users: roster.map((member) => member.userId) } : {}),
      },
    },
  ];
}

export type FormMode =
  | { kind: "fromMessage"; source: FormSource; suggestedCode: string }
  | { kind: "create"; source: FormSource }
  | { kind: "edit"; source: FormSource; reminder: Reminder; roster: readonly Host[] };

function formBlocks(mode: FormMode): KnownBlock[] {
  switch (mode.kind) {
    case "edit":
      return [
        codeDisplay(mode.reminder.code),
        messageInput(mode.reminder),
        ...scheduleInputs(mode.reminder, mode.roster),
      ];
    case "create":
      return [codeInput(""), messageInput(), ...scheduleInputs()];
    case "fromMessage":
      // No message input: the body is the Slack message, re-read on submit.
      return [codeInput(mode.suggestedCode), ...scheduleInputs()];
  }
}

export function reminderModal(mode: FormMode): View {
  const blocks = formBlocks(mode);

  return {
    type: "modal",
    callback_id: REMINDER_FORM,
    private_metadata: JSON.stringify(mode.source),
    title: { type: "plain_text", text: mode.kind === "edit" ? "Edit reminder" : "New reminder" },
    submit: { type: "plain_text", text: mode.kind === "edit" ? "Save" : "Create" },
    close: { type: "plain_text", text: "Cancel" },
    blocks,
  };
}

/** Absent fields are the blocks that mode did not render, not empty answers. */
export interface FormFields {
  code?: string;
  message?: string;
  at: string;
  lead?: string;
  preMessage?: string;
  dayNames: string[];
  everyNWeeks: number;
  hosts: string[];
}

/** Every input block uses the action id `value`, so each field is one lookup. */
export type Values = Record<string, Record<string, ViewStateValue>>;

export function readSubmission(values: Values): FormFields {
  const field = (block: string): ViewStateValue | undefined => values[block]?.value;
  const text = (block: string): string | undefined => {
    const value = field(block)?.value;
    return value === undefined || value === null ? undefined : value.trim();
  };

  return {
    code: text("code"),
    message: text("message"),
    at: text("at") ?? "",
    lead: text("lead"),
    preMessage: text("preMessage"),
    dayNames: (field("days")?.selected_options ?? []).map((option) => option.value),
    everyNWeeks: Number(field("cadence")?.selected_option?.value ?? 1),
    hosts: field("hosts")?.selected_users ?? [],
  };
}

/** Only the fields that actually changed. An absent key means: leave it alone. */
export interface PlannedEdit {
  at?: string;
  days?: string;
  everyNWeeks?: number;
  message?: string;
  leadMinutes?: number;
  preMessage?: string | null;
  hosts?: readonly string[];
}

/**
 * Writing a field that did not change is not a no-op here — `setReminderMessage`
 * also resets the body format to Markdown, which would silently reinterpret a
 * body captured from a Slack message, and re-planning the lap redraws an order
 * people have already read off `show`. So each write has to be earned.
 */
export function plannedEdit(
  existing: Reminder,
  roster: readonly Host[],
  fields: FormFields,
  at: string,
  days: string,
  leadMinutes: number,
): PlannedEdit {
  const planned: PlannedEdit = {};

  if (at !== existing.at) planned.at = at;
  if (days !== existing.days) planned.days = days;
  if (fields.everyNWeeks !== existing.everyNWeeks) planned.everyNWeeks = fields.everyNWeeks;
  if (fields.message !== undefined && fields.message !== existing.message) {
    planned.message = fields.message;
  }
  if (leadMinutes !== existing.leadMinutes) planned.leadMinutes = leadMinutes;

  const preMessage = fields.preMessage ?? null;
  if (preMessage !== existing.preMessage) planned.preMessage = preMessage;

  if (!sameRoster(roster, fields.hosts)) planned.hosts = fields.hosts;

  return planned;
}

/** The lead needs `at` to know how much room it has, and a lead that is set needs a body. */
function leadErrors(
  lead: Parsed<number>,
  at: Parsed<string>,
  preMessage: string | undefined,
): Record<string, string> {
  if (!lead.ok) return { lead: lead.error };

  const errors: Record<string, string> = {};

  if (at.ok) {
    const room = leadFitsBeforeMidnight(lead.value, at.value);
    if (!room.ok) errors.lead = room.error;
  }
  // An early post with nothing to say would be a bare "Heads Up at 10:25:".
  if (lead.value > NO_LEAD && !preMessage) {
    errors.preMessage = "A heads-up needs something to say.";
  }

  return errors;
}

/**
 * Keyed by block so Slack marks the offending field rather than replacing the
 * dialog. All local — a `view_submission` must be acked within three seconds.
 */
export function validate(
  fields: FormFields,
  takenCodes: ReadonlySet<string>,
): { errors: Record<string, string> } | { at: string; days: string; leadMinutes: number } {
  const errors: Record<string, string> = {};

  if (fields.code !== undefined) {
    if (!isReminderCode(fields.code)) {
      errors.code = `Use ${CODE_RULE} only — like \`standup\`.`;
    } else if (takenCodes.has(fields.code)) {
      errors.code = `\`${fields.code}\` already exists in this channel.`;
    }
  }

  if (fields.message !== undefined && fields.message === "") {
    errors.message = "A reminder needs something to say.";
  }

  const at = parseAt(fields.at);
  if (!at.ok) errors.at = at.error;

  const lead = parseLead(fields.lead);
  Object.assign(errors, leadErrors(lead, at, fields.preMessage));

  const days = daysFromSelection(fields.dayNames);
  if (!days.ok) {
    errors.days = days.error;
    return { errors };
  }

  const fits = cadenceFitsDays(fields.everyNWeeks, days.value);
  if (!fits.ok) errors.days = fits.error;

  if (!at.ok || !lead.ok || Object.keys(errors).length > 0) return { errors };
  return { at: at.value, days: days.value, leadMinutes: lead.value };
}

export const SKIP_FORM = "reminder_skip_form";

/**
 * A view submission does not carry the message it came from, so the post to
 * update and reply under rides here.
 */
export interface SkipSource {
  channelId: string;
  messageTs: string;
}

/** Slack enforces this client-side, which is why nothing re-checks it on submit. */
const MAX_REASON_LENGTH = 200;

/**
 * One shared post means a button cannot hide for just the person who clicked, so
 * this dialog is where they learn they are already down as skipping.
 */
export function skipModal(source: SkipSource, existing?: Skip): View {
  return {
    type: "modal",
    callback_id: SKIP_FORM,
    private_metadata: JSON.stringify(source),
    title: { type: "plain_text", text: existing ? "You're skipping" : "Skip me" },
    submit: { type: "plain_text", text: existing ? "Save" : "Skip" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "reason",
        optional: true,
        label: { type: "plain_text", text: "Reason" },
        hint: { type: "plain_text", text: "Optional, and shown on the reminder itself." },
        element: {
          type: "plain_text_input",
          action_id: "value",
          max_length: MAX_REASON_LENGTH,
          placeholder: { type: "plain_text", text: "sick, back tomorrow" },
          // Slack rejects an empty initial_value, so no reason means no key at all.
          ...(existing?.reason ? { initial_value: existing.reason } : {}),
        },
      },
    ],
  };
}

/** Undefined for a box left empty, which is a valid submission. */
export function readSkipReason(values: Values): string | undefined {
  return values.reason?.value?.value?.trim() || undefined;
}
