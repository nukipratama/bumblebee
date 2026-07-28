import type { App, MessageShortcut, ViewStateValue } from "@slack/bolt";
import type { KnownBlock, View, WebClient } from "@slack/web-api";
import { CODE_RULE, isReminderCode, suggestCode } from "../../domain/code.js";
import { DAY_NAMES, WEEKDAYS } from "../../domain/days.js";
import { planLap } from "../../domain/rotation.js";
import { cadenceFitsDays } from "../../domain/schedule.js";
import {
  getReminder,
  insertReminder,
  listHosts,
  listReminders,
  replaceHosts,
} from "../../store/reminders.js";
import { daysFromSelection, parseAt } from "../args.js";
import { formatSchedule } from "../text.js";

export const REMIND_FROM_MESSAGE = "remind_from_message";

const DEFAULT_TIME = "09:00";

/** Which message this dialog was opened from. Kept small — the field caps at 3000 characters. */
interface Source {
  channelId: string;
  messageTs: string;
}

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

function modalBlocks(suggestedCode: string): KnownBlock[] {
  return [
    {
      type: "input",
      block_id: "code",
      label: { type: "plain_text", text: "Name" },
      hint: { type: "plain_text", text: "How you'll refer to it: /bee-remind pause <name>" },
      element: {
        type: "plain_text_input",
        action_id: "value",
        initial_value: suggestedCode,
      },
    },
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
        initial_value: DEFAULT_TIME,
        placeholder: { type: "plain_text", text: "09:15" },
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
        initial_options: WEEKDAYS.map(dayOption),
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
        initial_option: CADENCE_OPTIONS[0],
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
      element: { type: "multi_users_select", action_id: "value" },
    },
  ];
}

function modal(source: Source, suggestedCode: string): View {
  return {
    type: "modal",
    callback_id: REMIND_FROM_MESSAGE,
    private_metadata: JSON.stringify(source),
    title: { type: "plain_text", text: "New reminder" },
    submit: { type: "plain_text", text: "Create" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: modalBlocks(suggestedCode),
  };
}

interface Submission {
  code: string;
  at: string;
  dayNames: string[];
  everyNWeeks: number;
  hosts: string[];
}

/** Every input block uses the action id `value`, so each field is one lookup. */
type Values = Record<string, Record<string, ViewStateValue>>;

export function readSubmission(values: Values): Submission {
  const field = (block: string): ViewStateValue | undefined => values[block]?.value;

  return {
    code: (field("code")?.value ?? "").trim(),
    at: (field("at")?.value ?? "").trim(),
    dayNames: (field("days")?.selected_options ?? []).map((option) => option.value),
    everyNWeeks: Number(field("cadence")?.selected_option?.value ?? 1),
    hosts: field("hosts")?.selected_users ?? [],
  };
}

/**
 * Keyed by block so Slack marks the offending field rather than replacing the
 * dialog. All local — a `view_submission` must be acked within three seconds.
 */
export function validate(
  submission: Submission,
  channelId: string,
): { errors: Record<string, string> } | { at: string; days: string } {
  const errors: Record<string, string> = {};

  if (!isReminderCode(submission.code)) {
    errors.code = `Use ${CODE_RULE} only — like \`standup\`.`;
  } else if (getReminder(channelId, submission.code)) {
    errors.code = `\`${submission.code}\` already exists in this channel.`;
  }

  const at = parseAt(submission.at);
  if (!at.ok) errors.at = at.error;

  const days = daysFromSelection(submission.dayNames);
  if (!days.ok) {
    errors.days = days.error;
    return { errors };
  }

  const fits = cadenceFitsDays(submission.everyNWeeks, days.value);
  if (!fits.ok) errors.days = fits.error;

  if (!at.ok || Object.keys(errors).length > 0) return { errors };
  return { at: at.value, days: days.value };
}

/** Re-read so an edit made since the shortcut was clicked is picked up. */
async function readSourceMessage(client: WebClient, source: Source): Promise<string | undefined> {
  const history = await client.conversations.history({
    channel: source.channelId,
    latest: source.messageTs,
    oldest: source.messageTs,
    inclusive: true,
    limit: 1,
  });
  return history.messages?.[0]?.text?.trim() || undefined;
}

export function registerShortcut(app: App): void {
  app.shortcut<MessageShortcut>(REMIND_FROM_MESSAGE, async ({ ack, shortcut, client, logger }) => {
    await ack();
    try {
      const channelId = shortcut.channel.id;
      const userId = shortcut.user.id;

      const complain = (text: string) =>
        client.chat.postEphemeral({ channel: channelId, user: userId, text });

      if (channelId.startsWith("D")) {
        await complain("Reminders belong to a channel — try this on a message in one.");
        return;
      }
      if (!shortcut.message.text?.trim()) {
        await complain("That message has no text I can turn into a reminder.");
        return;
      }

      const taken = new Set(listReminders(channelId).map((reminder) => reminder.code));
      const source: Source = { channelId, messageTs: shortcut.message_ts };

      // trigger_id expires in about three seconds, so nothing slow happens first.
      await client.views.open({
        trigger_id: shortcut.trigger_id,
        view: modal(source, suggestCode(shortcut.message.text, taken)),
      });
    } catch (error) {
      logger.error("remind-from-message shortcut failed", error);
    }
  });

  app.view(REMIND_FROM_MESSAGE, async ({ ack, body, view, client, logger }) => {
    const source = JSON.parse(view.private_metadata) as Source;
    const submission = readSubmission(view.state.values);
    const userId = body.user.id;

    const checked = validate(submission, source.channelId);
    if ("errors" in checked) {
      await ack({ response_action: "errors", errors: checked.errors });
      return;
    }

    // Before the ack, so a deleted message can still be reported on the dialog.
    let message: string | undefined;
    try {
      message = await readSourceMessage(client, source);
    } catch (error) {
      logger.error("could not re-read the source message", error);
    }

    if (!message) {
      await ack({
        response_action: "errors",
        errors: { code: "I can't read that message any more — it may have been deleted." },
      });
      return;
    }

    await ack();

    try {
      insertReminder({
        channelId: source.channelId,
        code: submission.code,
        at: checked.at,
        days: checked.days,
        message,
        bodyFormat: "mrkdwn",
        everyNWeeks: submission.everyNWeeks,
        createdBy: userId,
      });

      const created = getReminder(source.channelId, submission.code)!;
      if (submission.hosts.length > 0) {
        replaceHosts(created.id, submission.hosts, planLap(listHosts(created.id), submission.hosts));
      }

      const rotation = submission.hosts.length > 0 ? ` · ${submission.hosts.length} hosts` : "";
      await client.chat.postMessage({
        channel: source.channelId,
        text: `<@${userId}> added reminder \`${created.code}\` — ${formatSchedule(created)}${rotation}`,
      });
    } catch (error) {
      logger.error("creating a reminder from a message failed", error);
      await client.chat.postEphemeral({
        channel: source.channelId,
        user: userId,
        text: "That didn't work. Check the logs.",
      });
    }
  });
}
