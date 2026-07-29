import type { App, BlockAction, ButtonAction, Logger } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { drawLapAvoiding, pendingLap } from "../../domain/rotation.js";
import type { Fire, Reminder } from "../../domain/types.js";
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
import {
  fallbackText,
  type PostBody,
  reminderBlocks,
  reminderBody,
  SKIP_ACTION,
} from "../blocks.js";
import { SKIP_FORM, type SkipSource, readSkipReason, skipModal } from "../modals.js";

const HANDOVER_GRACE_MS = 30 * 60_000;

const REMINDER_GONE = "I can't find the reminder this belongs to — it may have been removed.";

/** Local, because `fired_on` is a date and the whole scheduler reads the local clock. */
function meetingTimeMs(fire: Fire, reminder: Reminder): number {
  return new Date(`${fire.firedOn}T${reminder.at}:00`).getTime();
}

/**
 * Past this the meeting has effectively happened, and rewriting who was
 * responsible revises history. Measured from the meeting rather than the fire: a
 * reminder with a lead fires while nobody is in the call yet. Attendance has no
 * such limit — it changes nothing anyone acted on.
 */
function handoverOpen(fire: Fire, reminder: Reminder, now: number): boolean {
  return now <= meetingTimeMs(fire, reminder) + HANDOVER_GRACE_MS;
}

/** Undefined when they may go ahead. Checked on the click and again on submit. */
export function handoverTooLate(
  fire: Fire,
  reminder: Reminder,
  clicker: string,
  now: number,
): string | undefined {
  return fire.hostUserId === clicker && !handoverOpen(fire, reminder, now)
    ? `\`${reminder.code}\` started over 30 minutes ago — too late to hand over hosting.`
    : undefined;
}

interface SkipOutcome {
  ephemeral?: string;
  handover?: string;
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
      handover:
        `⚠️ Everyone left in the rotation has skipped, so nobody is hosting` +
        ` — <@${clicker}> keeps their turn.`,
    };
  }

  setFireHost(fire.id, replacement);
  return {
    handover: `🔁 <@${replacement}> is hosting instead — <@${clicker}> keeps their turn.`,
  };
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
  return {};
}

/** Both posts carry the button and the same skip list, so both are rewritten. */
function postsOf(fire: Fire, reminder: Reminder): { ts: string; which: PostBody }[] {
  const posts: { ts: string; which: PostBody }[] = [];
  if (fire.messageTs) {
    posts.push({ ts: fire.messageTs, which: reminder.leadMinutes > 0 ? "heads-up" : "meeting" });
  }
  if (fire.joinMessageTs) posts.push({ ts: fire.joinMessageTs, which: "meeting" });
  return posts;
}

async function repost(
  client: WebClient,
  fire: Fire,
  reminder: Reminder,
  channelId: string,
  messageTs: string,
): Promise<void> {
  // Re-read rather than reuse `fire`: a handover has just changed the host.
  const current = getFireByMessageTs(messageTs) ?? fire;

  const hasRoster = listHosts(reminder.id).length > 0;
  const skips = listSkips(current.id);

  for (const { ts, which } of postsOf(current, reminder)) {
    const post = {
      code: reminder.code,
      ...reminderBody(reminder, which),
      host: current.hostUserId ?? undefined,
      // A rostered reminder always names a host when it fires, so losing one means
      // a handover found nobody available.
      hostUnavailable: hasRoster && !current.hostUserId,
      skips,
      skippable: hasRoster,
    };

    await client.chat.update({
      channel: channelId,
      ts,
      blocks: reminderBlocks(post),
      text: fallbackText(post),
    });
  }
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
    await repost(client, fire, reminder, source.channelId, source.messageTs);
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

  // The reason rides on the posts themselves; a handover is the one thing that
  // has to reach the person who just picked up the job.
  if (outcome.handover) {
    await client.chat.postMessage({
      channel: source.channelId,
      thread_ts: source.messageTs,
      text: outcome.handover,
    });
  }

  logger.info(`skip on \`${reminder.code}\` by ${clicker}`);
}
