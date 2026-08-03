import type { App, BlockAction, ButtonAction, Logger } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { hostChangeOpen } from "../../domain/handover.js";
import { drawLapAvoiding, pendingLap } from "../../domain/rotation.js";
import type { Fire, Reminder } from "../../domain/types.js";
import { repost } from "../repost.js";
import {
  addSkip,
  getFireByMessageTs,
  getReminderById,
  getSkip,
  listHosts,
  listSkips,
  setFireHost,
  setLap,
} from "../../store/reminders.js";
import { escapeMrkdwn, SKIP_ACTION } from "../blocks.js";
import { SKIP_FORM, type SkipSource, readSkipReason, skipModal } from "../modals.js";

const REMINDER_GONE = "I can't find the reminder this belongs to — it may have been removed.";

/** Undefined when they may go ahead. Checked on the click and again on submit. */
export function handoverTooLate(
  fire: Fire,
  reminder: Reminder,
  clicker: string,
  now: number,
): string | undefined {
  return fire.hostUserId === clicker && !hostChangeOpen(fire, reminder, now)
    ? `\`${reminder.code}\` started over 30 minutes ago — too late to hand over hosting.`
    : undefined;
}

interface SkipOutcome {
  ephemeral?: string;
  announce?: string;
}

function handOver(
  fire: Fire,
  reminder: Reminder,
  clicker: string,
  reason: string | null,
): SkipOutcome {
  const roster = listHosts(reminder.id);
  const rosterIds = roster.map((member) => member.userId);
  const lap = pendingLap(roster);

  if (rosterIds.length < 2) {
    return { ephemeral: `You're the only person on \`${reminder.code}\` — nobody to hand over to.` };
  }

  // An empty pending lap means this fire closed it, so a fresh one is drawn.
  const next = lap.length > 0 ? lap : drawLapAvoiding(rosterIds, clicker);

  // Handing over to someone who already said they're away would name a host who
  // isn't coming, so they are passed over.
  const skipping = new Set(listSkips(fire.id).map((skip) => skip.userId));
  const replacement = next.find((userId) => userId !== clicker && !skipping.has(userId));

  // The clicker rejoins at the back, which is what keeps their turn. Anyone
  // passed over keeps their place — skipping costs nobody a turn.
  const remaining = next.filter((userId) => userId !== clicker && userId !== replacement);
  setLap(reminder.id, [...remaining, clicker]);
  // They clicked Skip me, so they are skipping as well as not hosting.
  addSkip(fire.id, clicker, reason);

  if (!replacement) {
    setFireHost(fire.id, null);
    return {
      announce:
        `⚠️ Everyone left in the rotation has skipped, so nobody is hosting` +
        ` — <@${clicker}> keeps their turn.`,
    };
  }

  setFireHost(fire.id, replacement);
  return {
    announce: `🔁 <@${replacement}> is hosting instead — <@${clicker}> keeps their turn.`,
  };
}

/** Mirrors `skipLine()`'s reason formatting so the thread notice reads consistently. */
function skipNotice(reminder: Reminder, clicker: string, reason: string | null): string {
  const suffix = reason ? ` - ${escapeMrkdwn(reason)}` : "";
  return `🙅 <@${clicker}> is skipping \`${reminder.code}\`${suffix}`;
}

export interface SkipRequest {
  fire: Fire;
  reminder: Reminder;
  clicker: string;
  reason?: string;
  now: number;
}

export function applySkip({ fire, reminder, clicker, reason, now }: SkipRequest): SkipOutcome {
  const tooLate = handoverTooLate(fire, reminder, clicker, now);
  if (tooLate) return { ephemeral: tooLate };

  const stored = reason ?? null;
  if (fire.hostUserId === clicker) return handOver(fire, reminder, clicker, stored);

  addSkip(fire.id, clicker, stored);
  return { announce: skipNotice(reminder, clicker, stored) };
}

async function openSkipForm(body: BlockAction<ButtonAction>, client: WebClient): Promise<void> {
  const messageTs = body.message?.ts;
  const channelId = body.channel?.id;
  const clicker = body.user.id;
  if (!messageTs || !channelId) return;

  const fire = getFireByMessageTs(messageTs);
  const reminder = fire && getReminderById(fire.reminderId);
  if (!fire || !reminder) {
    await client.chat.postEphemeral({ channel: channelId, user: clicker, text: REMINDER_GONE });
    return;
  }

  // Refused here as well as on submit, so nobody types a reason we then throw away.
  const tooLate = handoverTooLate(fire, reminder, clicker, Date.now());
  if (tooLate) {
    await client.chat.postEphemeral({ channel: channelId, user: clicker, text: tooLate });
    return;
  }

  // trigger_id expires in about three seconds, so the two reads above are all SQLite.
  await client.views.open({
    trigger_id: body.trigger_id,
    view: skipModal({ channelId, messageTs }, getSkip(fire.id, clicker)),
  });
}

export function registerSkip(app: App): void {
  app.action<BlockAction<ButtonAction>>(SKIP_ACTION, async ({ ack, body, client, logger }) => {
    await ack();
    try {
      await openSkipForm(body, client);
    } catch (error) {
      logger.error("opening the skip form failed", error);
    }
  });

  app.view(SKIP_FORM, async ({ ack, body, view, client, logger }) => {
    const source = JSON.parse(view.private_metadata) as SkipSource;
    const clicker = body.user.id;
    const reason = readSkipReason(view.state.values);

    const fire = getFireByMessageTs(source.messageTs);
    const reminder = fire && getReminderById(fire.reminderId);
    if (!fire || !reminder) {
      await ack({
        response_action: "errors",
        errors: { reason: REMINDER_GONE },
      });
      return;
    }

    const now = Date.now();
    const tooLate = handoverTooLate(fire, reminder, clicker, now);
    if (tooLate) {
      await ack({ response_action: "errors", errors: { reason: tooLate } });
      return;
    }

    await ack();

    const outcome = applySkip({ fire, reminder, clicker, reason, now });
    await settle(client, outcome, fire, reminder, clicker, source, logger);
  });
}

/**
 * Each Slack call is caught on its own: the skip is already written by now, so one
 * failing post must not swallow the rest.
 */
async function settle(
  client: WebClient,
  outcome: SkipOutcome,
  fire: Fire,
  reminder: Reminder,
  clicker: string,
  source: SkipSource,
  logger: Logger,
): Promise<void> {
  try {
    // Re-read rather than reuse `fire`: a handover has just changed the host.
    const current = getFireByMessageTs(source.messageTs) ?? fire;
    await repost(client, current, reminder, source.channelId);
  } catch (error) {
    logger.error("updating the post failed", error);
    await client.chat
      .postEphemeral({
        channel: source.channelId,
        user: clicker,
        text: "I recorded that, but updating the post failed — it may have been deleted.",
      })
      .catch(() => undefined);
  }

  if (outcome.ephemeral) {
    await client.chat.postEphemeral({
      channel: source.channelId,
      user: clicker,
      text: outcome.ephemeral,
    });
  }

  // Announced in the thread of whichever post was clicked, so the confirmation
  // follows the button rather than always landing on one specific post.
  if (outcome.announce) {
    await client.chat.postMessage({
      channel: source.channelId,
      thread_ts: source.messageTs,
      text: outcome.announce,
    });
  }

  logger.info(`skip on \`${reminder.code}\` by ${clicker}`);
}
