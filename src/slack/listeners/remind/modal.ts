import type { App, BlockAction, ButtonAction } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { planLap } from "../../../domain/rotation.js";
import type { Reminder } from "../../../domain/types.js";
import {
  getReminder,
  insertReminder,
  listHosts,
  listReminders,
  replaceHosts,
  setReminderAt,
  setReminderCadence,
  setReminderDays,
  setReminderMessage,
} from "../../../store/reminders.js";
import { EDIT_REMINDER_ACTION, NEW_REMINDER_ACTION } from "../../blocks.js";
import {
  REMINDER_FORM,
  type FormFields,
  type FormSource,
  plannedEdit,
  readSubmission,
  reminderModal,
  validate,
} from "../../modals.js";
import { formatSchedule, mention } from "../../text.js";

const takenCodes = (channelId: string): Set<string> =>
  new Set(listReminders(channelId).map((reminder) => reminder.code));

/** Re-read so an edit made since the form was opened is picked up. */
async function readSourceMessage(
  client: WebClient,
  channelId: string,
  messageTs: string,
): Promise<string | undefined> {
  const history = await client.conversations.history({
    channel: channelId,
    latest: messageTs,
    oldest: messageTs,
    inclusive: true,
    limit: 1,
  });
  return history.messages?.[0]?.text?.trim() || undefined;
}

function applyEdit(existing: Reminder, fields: FormFields, at: string, days: string): void {
  const { channelId, code } = existing;
  const roster = listHosts(existing.id);
  const planned = plannedEdit(existing, roster, fields, at, days);

  if (planned.at !== undefined) setReminderAt(channelId, code, planned.at);
  if (planned.days !== undefined) setReminderDays(channelId, code, planned.days);
  if (planned.everyNWeeks !== undefined) setReminderCadence(channelId, code, planned.everyNWeeks);
  if (planned.message !== undefined) setReminderMessage(channelId, code, planned.message);
  if (planned.hosts !== undefined) {
    replaceHosts(existing.id, planned.hosts, planLap(roster, planned.hosts));
  }
}

export function registerReminderForm(app: App): void {
  app.action<BlockAction<ButtonAction>>(
    NEW_REMINDER_ACTION,
    async ({ ack, body, client, logger }) => {
      await ack();
      try {
        const channelId = body.channel!.id;
        await client.views.open({
          trigger_id: body.trigger_id,
          view: reminderModal({ kind: "create", source: { kind: "create", channelId } }),
        });
      } catch (error) {
        logger.error("opening the new-reminder form failed", error);
      }
    },
  );

  app.action<BlockAction<ButtonAction>>(
    EDIT_REMINDER_ACTION,
    async ({ ack, body, client, logger }) => {
      await ack();
      try {
        const channelId = body.channel!.id;
        const code = body.actions[0]!.value!;
        const reminder = getReminder(channelId, code);
        if (!reminder) {
          await client.chat.postEphemeral({
            channel: channelId,
            user: body.user.id,
            text: `\`${code}\` no longer exists — nothing to edit.`,
          });
          return;
        }

        await client.views.open({
          trigger_id: body.trigger_id,
          view: reminderModal({
            kind: "edit",
            source: { kind: "edit", channelId, code },
            reminder,
            roster: listHosts(reminder.id),
          }),
        });
      } catch (error) {
        logger.error("opening the edit form failed", error);
      }
    },
  );

  app.view(REMINDER_FORM, async ({ ack, body, view, client, logger }) => {
    const source = JSON.parse(view.private_metadata) as FormSource;
    const fields = readSubmission(view.state.values);
    const userId = body.user.id;

    const existing = source.kind === "edit" ? getReminder(source.channelId, source.code) : undefined;
    if (source.kind === "edit" && !existing) {
      await ack({
        response_action: "errors",
        errors: { message: `\`${source.code}\` no longer exists — nothing was changed.` },
      });
      return;
    }

    const checked = validate(fields, takenCodes(source.channelId));
    if ("errors" in checked) {
      await ack({ response_action: "errors", errors: checked.errors });
      return;
    }

    // Before the ack, so a deleted message can still be reported on the dialog.
    let captured: string | undefined;
    if (source.kind === "fromMessage") {
      try {
        captured = await readSourceMessage(client, source.channelId, source.messageTs);
      } catch (error) {
        logger.error("could not re-read the source message", error);
      }
      if (!captured) {
        await ack({
          response_action: "errors",
          errors: { code: "I can't read that message any more — it may have been deleted." },
        });
        return;
      }
    }

    await ack();

    try {
      if (existing) {
        applyEdit(existing, fields, checked.at, checked.days);
        const updated = getReminder(existing.channelId, existing.code)!;
        await client.chat.postMessage({
          channel: existing.channelId,
          text: `${mention(userId)} edited reminder \`${updated.code}\` — now ${formatSchedule(updated)}`,
        });
        return;
      }

      insertReminder({
        channelId: source.channelId,
        code: fields.code!,
        at: checked.at,
        days: checked.days,
        message: captured ?? fields.message!,
        bodyFormat: captured ? "mrkdwn" : "markdown",
        everyNWeeks: fields.everyNWeeks,
        createdBy: userId,
      });

      const created = getReminder(source.channelId, fields.code!)!;
      if (fields.hosts.length > 0) {
        replaceHosts(created.id, fields.hosts, planLap(listHosts(created.id), fields.hosts));
      }

      const rotation = fields.hosts.length > 0 ? ` · ${fields.hosts.length} hosts` : "";
      const announcement = `${mention(userId)} added reminder \`${created.code}\` — ${formatSchedule(created)}${rotation}`;

      // Threaded on the message it was built from, and broadcast so the channel
      // still sees it — a fresh thread has no followers.
      if (source.kind === "fromMessage") {
        await client.chat.postMessage({
          channel: source.channelId,
          thread_ts: source.messageTs,
          reply_broadcast: true,
          text: announcement,
        });
      } else {
        await client.chat.postMessage({ channel: source.channelId, text: announcement });
      }
    } catch (error) {
      logger.error("saving the reminder form failed", error);
      await client.chat.postEphemeral({
        channel: source.channelId,
        user: userId,
        text: "That didn't work. Check the logs.",
      });
    }
  });
}
