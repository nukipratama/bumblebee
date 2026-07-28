import type { App, BlockAction, ButtonAction, Logger } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { drawLapAvoiding, pendingLap } from "../../domain/rotation.js";
import type { Fire, Reminder } from "../../domain/types.js";
import {
  addSkip,
  getFireByMessageTs,
  getReminderById,
  listHosts,
  listSkips,
  setFireHost,
  setLap,
} from "../../store/reminders.js";
import { SKIP_ACTION, fallbackText, reminderBlocks } from "../blocks.js";

/**
 * Past this the meeting has effectively happened, and rewriting who was
 * responsible revises history. Attendance has no such limit — it changes nothing
 * anyone acted on.
 */
const HANDOVER_WINDOW_MS = 30 * 60_000;

interface SkipOutcome {
  ephemeral?: string;
  thread?: string;
}

function handoverOpen(fire: Fire, now: number): boolean {
  // Null on rows written before fired_at existed, which reads as too old to hand over.
  if (!fire.firedAt) return false;
  return now - new Date(fire.firedAt).getTime() <= HANDOVER_WINDOW_MS;
}

function handOver(fire: Fire, reminder: Reminder, clicker: string): SkipOutcome {
  const roster = listHosts(reminder.id);
  const rosterIds = roster.map((member) => member.userId);
  const lap = pendingLap(roster);

  if (rosterIds.length < 2) {
    return { ephemeral: `You're the only person on \`${reminder.code}\` — nobody to hand over to.` };
  }

  // An empty pending lap means this fire closed it, so a fresh one is drawn.
  const next = lap.length > 0 ? lap : drawLapAvoiding(rosterIds, clicker);
  const replacement = next[0]!;

  // The clicker rejoins at the back, which is what keeps their turn. The filter
  // matters when the lap was just redrawn and already contains them.
  const remaining = next.slice(1).filter((userId) => userId !== clicker);

  setFireHost(fire.id, replacement);
  setLap(reminder.id, [...remaining, clicker]);
  // They clicked Skip today, so they are out today as well as not hosting it.
  addSkip(fire.id, clicker);

  return {
    thread: `🔁 <@${replacement}> is hosting today instead — <@${clicker}> keeps their turn.`,
  };
}

export function applySkip(
  fire: Fire,
  reminder: Reminder,
  clicker: string,
  now: number,
): SkipOutcome {
  const isHost = fire.hostUserId === clicker;

  if (isHost && !handoverOpen(fire, now)) {
    return {
      ephemeral: `\`${reminder.code}\` fired over 30 minutes ago — too late to hand over hosting.`,
    };
  }
  if (isHost) return handOver(fire, reminder, clicker);

  return addSkip(fire.id, clicker)
    ? {}
    : { ephemeral: `You're already down as out of \`${reminder.code}\` today.` };
}

async function repost(
  client: WebClient,
  fire: Fire,
  reminder: Reminder,
  channelId: string,
  messageTs: string,
  now: number,
): Promise<void> {
  // Re-read rather than reuse `fire`: a handover has just changed the host.
  const current = getFireByMessageTs(messageTs) ?? fire;

  const post = {
    body: reminder.message,
    bodyFormat: reminder.bodyFormat,
    host: current.hostUserId ?? undefined,
    outToday: listSkips(fire.id),
    skippable: listHosts(reminder.id).length > 0,
    windowClosed: !handoverOpen(fire, now),
  };

  await client.chat.update({
    channel: channelId,
    ts: messageTs,
    blocks: reminderBlocks(post),
    text: fallbackText(post),
  });
}

async function handleSkip(
  body: BlockAction<ButtonAction>,
  client: WebClient,
  logger: Logger,
): Promise<void> {
  const messageTs = body.message?.ts;
  const channelId = body.channel?.id;
  const clicker = body.user.id;
  if (!messageTs || !channelId) return;

  const fire = getFireByMessageTs(messageTs);
  const reminder = fire && getReminderById(fire.reminderId);
  if (!fire || !reminder) {
    await client.chat.postEphemeral({
      channel: channelId,
      user: clicker,
      text: "I can't find the reminder this belongs to — it may have been removed.",
    });
    return;
  }

  const now = Date.now();
  const outcome = applySkip(fire, reminder, clicker, now);

  await repost(client, fire, reminder, channelId, messageTs, now);

  if (outcome.ephemeral) {
    await client.chat.postEphemeral({ channel: channelId, user: clicker, text: outcome.ephemeral });
  }
  if (outcome.thread) {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: messageTs,
      text: outcome.thread,
    });
  }

  logger.info(`skip on \`${reminder.code}\` by ${clicker}`);
}

export function registerSkip(app: App): void {
  app.action<BlockAction<ButtonAction>>(SKIP_ACTION, async ({ ack, body, client, logger }) => {
    await ack();
    try {
      await handleSkip(body, client, logger);
    } catch (error) {
      logger.error("skip failed", error);
    }
  });
}
