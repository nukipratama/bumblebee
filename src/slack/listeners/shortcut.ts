import type { App, MessageShortcut } from "@slack/bolt";
import { suggestCode } from "../../domain/code.js";
import { listReminders } from "../../store/reminders.js";
import { reminderModal } from "../modals.js";

export const REMIND_FROM_MESSAGE = "remind_from_message";

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

      // trigger_id expires in about three seconds, so nothing slow happens first.
      await client.views.open({
        trigger_id: shortcut.trigger_id,
        view: reminderModal({
          kind: "fromMessage",
          source: { kind: "fromMessage", channelId, messageTs: shortcut.message_ts },
          suggestedCode: suggestCode(shortcut.message.text, taken),
        }),
      });
    } catch (error) {
      logger.error("remind-from-message shortcut failed", error);
    }
  });
}
