import type { App, BlockAction, ButtonAction, Logger } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import type { Fire, Reminder } from "../../domain/types.js";
import { getFireByMessageTs, getReminderById, getReport, setReportNotice, upsertReport } from "../../store/reminders.js";
import { BUZZ_ACTION } from "../blocks.js";
import { BUZZ_FORM, MAX_UPDATE_LENGTH, type SkipSource, buzzModal, readBuzz } from "../modals.js";
import { repost } from "../repost.js";

const REMINDER_GONE = "I can't find the reminder this belongs to — it may have been removed.";

/** `body` is already mrkdwn-ready — see `renderRichText` in `../rich-text.js`. */
export function buzzNotice(
  reminder: Reminder,
  clicker: string,
  body: string,
  syncWith: readonly string[],
): string {
  const lines = [`🐝 <@${clicker}> buzzed in on \`${reminder.code}\`:`, body];
  if (syncWith.length > 0) {
    lines.push(`🤝 Needs sync with ${syncWith.map((userId) => `<@${userId}>`).join(" ")}`);
  }
  return lines.join("\n");
}

export interface BuzzRequest {
  fire: Fire;
  reminder: Reminder;
  clicker: string;
  body: string;
  syncWith: readonly string[];
}

/** Writes only the report: hosting, the lap and skips are left alone whoever clicks. */
export function recordBuzz({ fire, reminder, clicker, body, syncWith }: BuzzRequest): {
  text: string;
  noticeTs: string | null;
} {
  upsertReport(fire.id, clicker, body, syncWith);
  return {
    text: buzzNotice(reminder, clicker, body, syncWith),
    noticeTs: getReport(fire.id, clicker)?.noticeTs ?? null,
  };
}

async function openBuzzForm(body: BlockAction<ButtonAction>, client: WebClient): Promise<void> {
  const messageTs = body.message?.ts;
  const channelId = body.channel?.id;
  const clicker = body.user.id;
  if (!messageTs || !channelId) return;

  const fire = getFireByMessageTs(messageTs);
  if (!fire) {
    await client.chat.postEphemeral({ channel: channelId, user: clicker, text: REMINDER_GONE });
    return;
  }

  await client.views.open({
    trigger_id: body.trigger_id,
    view: buzzModal({ channelId, messageTs }, getReport(fire.id, clicker)),
  });
}

export function registerBuzz(app: App): void {
  app.action<BlockAction<ButtonAction>>(BUZZ_ACTION, async ({ ack, body, client, logger }) => {
    await ack();
    try {
      await openBuzzForm(body, client);
    } catch (error) {
      logger.error("opening the buzz form failed", error);
    }
  });

  app.view(BUZZ_FORM, async ({ ack, body, view, client, logger }) => {
    const source = JSON.parse(view.private_metadata) as SkipSource;
    const clicker = body.user.id;
    const { body: update, syncWith } = readBuzz(view.state.values);

    if (!update) {
      await ack({ response_action: "errors", errors: { update: "Write your update first." } });
      return;
    }
    if (update.length > MAX_UPDATE_LENGTH) {
      await ack({
        response_action: "errors",
        errors: { update: `Keep it under ${MAX_UPDATE_LENGTH} characters — this one is ${update.length}.` },
      });
      return;
    }

    const fire = getFireByMessageTs(source.messageTs);
    const reminder = fire && getReminderById(fire.reminderId);
    if (!fire || !reminder) {
      await ack({ response_action: "errors", errors: { update: REMINDER_GONE } });
      return;
    }

    await ack();

    const notice = recordBuzz({ fire, reminder, clicker, body: update, syncWith });
    await settle(client, fire, reminder, clicker, source, notice, logger);
  });
}

/** Each Slack call is caught on its own: the report is already written by now. */
async function settle(
  client: WebClient,
  fire: Fire,
  reminder: Reminder,
  clicker: string,
  source: SkipSource,
  notice: { text: string; noticeTs: string | null },
  logger: Logger,
): Promise<void> {
  try {
    if (notice.noticeTs) {
      await client.chat.update({ channel: source.channelId, ts: notice.noticeTs, text: notice.text });
    } else {
      const posted = await client.chat.postMessage({
        channel: source.channelId,
        thread_ts: source.messageTs,
        text: notice.text,
        unfurl_links: false,
        unfurl_media: false,
      });
      if (posted.ts) setReportNotice(fire.id, clicker, posted.ts);
    }
  } catch (error) {
    logger.error("posting the update in the thread failed", error);
    await client.chat
      .postEphemeral({
        channel: source.channelId,
        user: clicker,
        text: "I recorded your update, but posting it in the thread failed.",
      })
      .catch(() => undefined);
  }

  try {
    await repost(client, getFireByMessageTs(source.messageTs) ?? fire, reminder, source.channelId);
  } catch (error) {
    logger.error("updating the post failed", error);
  }

  logger.info(`buzz on \`${reminder.code}\` by ${clicker}`);
}
