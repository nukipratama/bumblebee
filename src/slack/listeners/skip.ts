import type { App, BlockAction, ButtonAction, Logger } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { drawLapAvoiding, pendingLap } from "../../domain/rotation.js";
import type { Fire, Reminder, Skip } from "../../domain/types.js";
import {
  addSkip,
  getFireByMessageTs,
  getReminderById,
  getSkip,
  listHosts,
  listSkips,
  setFireHost,
  setLap,
  setSkipNoticeTs,
} from "../../store/reminders.js";
import { SKIP_ACTION, fallbackText, reminderBlocks } from "../blocks.js";
import { SKIP_FORM, type SkipSource, readSkipReason, skipModal } from "../modals.js";

/**
 * Past this the meeting has effectively happened, and rewriting who was
 * responsible revises history. Attendance has no such limit — it changes nothing
 * anyone acted on.
 */
const HANDOVER_WINDOW_MS = 30 * 60_000;

const REMINDER_GONE = "I can't find the reminder this belongs to — it may have been removed.";

/** The thread reply carrying a reason, which an edit rewrites rather than repeats. */
type Notice =
  | { kind: "post"; text: string }
  | { kind: "update"; ts: string; text: string }
  | { kind: "delete"; ts: string };

interface SkipOutcome {
  ephemeral?: string;
  handover?: string;
  notice?: Notice;
}

function handoverOpen(fire: Fire, now: number): boolean {
  // Null on rows written before fired_at existed, which reads as too old to hand over.
  if (!fire.firedAt) return false;
  return now - new Date(fire.firedAt).getTime() <= HANDOVER_WINDOW_MS;
}

/** Undefined when they may go ahead. Checked on the click and again on submit. */
export function handoverTooLate(
  fire: Fire,
  reminder: Reminder,
  clicker: string,
  now: number,
): string | undefined {
  return fire.hostUserId === clicker && !handoverOpen(fire, now)
    ? `\`${reminder.code}\` fired over 30 minutes ago — too late to hand over hosting.`
    : undefined;
}

/** A reason is typed literally, so `<!channel>` in one must not become a ping. */
function noticeText(clicker: string, reason: string): string {
  const escaped = reason.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `🔕 <@${clicker}> is skipping — ${escaped}`;
}

/** Nothing to say when the reason is what it already was. */
function noticeFor(
  clicker: string,
  reason: string | null,
  previous: Skip | undefined,
): Notice | undefined {
  if (reason === (previous?.reason ?? null)) return undefined;

  const ts = previous?.noticeTs;
  if (!reason) return ts ? { kind: "delete", ts } : undefined;
  const text = noticeText(clicker, reason);
  return ts ? { kind: "update", ts, text } : { kind: "post", text };
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
  const skipping = new Set(listSkips(fire.id));
  const replacement = next.find((userId) => userId !== clicker && !skipping.has(userId));

  // The clicker rejoins at the back, which is what keeps their turn. Anyone
  // passed over keeps their place — skipping costs nobody a turn.
  const remaining = next.filter((userId) => userId !== clicker && userId !== replacement);
  setLap(reminder.id, [...remaining, clicker]);
  // They clicked Skip me, so they are skipping as well as not hosting.
  const previous = addSkip(fire.id, clicker, reason);
  const notice = noticeFor(clicker, reason, previous);

  if (!replacement) {
    setFireHost(fire.id, null);
    return {
      handover:
        `⚠️ Everyone left in the rotation has skipped, so nobody is hosting` +
        ` — <@${clicker}> keeps their turn.`,
      notice,
    };
  }

  setFireHost(fire.id, replacement);
  return {
    handover: `🔁 <@${replacement}> is hosting instead — <@${clicker}> keeps their turn.`,
    notice,
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

  const previous = addSkip(fire.id, clicker, stored);
  return { notice: noticeFor(clicker, stored, previous) };
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

  const post = {
    code: reminder.code,
    body: reminder.message,
    bodyFormat: reminder.bodyFormat,
    host: current.hostUserId ?? undefined,
    // A rostered reminder always names a host when it fires, so losing one means
    // a handover found nobody available.
    hostUnavailable: hasRoster && !current.hostUserId,
    skips: listSkips(fire.id),
    skippable: hasRoster,
  };

  await client.chat.update({
    channel: channelId,
    ts: messageTs,
    blocks: reminderBlocks(post),
    text: fallbackText(post),
  });
}

async function applyNotice(
  client: WebClient,
  notice: Notice,
  fireId: number,
  clicker: string,
  source: SkipSource,
): Promise<void> {
  if (notice.kind === "delete") {
    // Someone may have deleted the reply by hand; the row must stop pointing at it either way.
    await client.chat.delete({ channel: source.channelId, ts: notice.ts }).catch(() => undefined);
    setSkipNoticeTs(fireId, clicker, null);
    return;
  }

  if (notice.kind === "update") {
    await client.chat.update({ channel: source.channelId, ts: notice.ts, text: notice.text });
    return;
  }

  const posted = await client.chat.postMessage({
    channel: source.channelId,
    thread_ts: source.messageTs,
    text: notice.text,
    unfurl_links: false,
    unfurl_media: false,
  });
  if (posted.ts) setSkipNoticeTs(fireId, clicker, posted.ts);
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
  const report = async (error: unknown, what: string): Promise<void> => {
    logger.error(`${what} failed`, error);
    await client.chat
      .postEphemeral({
        channel: source.channelId,
        user: clicker,
        text: `I recorded that, but ${what} failed — the post may have been deleted.`,
      })
      .catch(() => undefined);
  };

  try {
    await repost(client, fire, reminder, source.channelId, source.messageTs);
  } catch (error) {
    await report(error, "updating the post");
  }

  if (outcome.ephemeral) {
    await client.chat.postEphemeral({
      channel: source.channelId,
      user: clicker,
      text: outcome.ephemeral,
    });
  }

  if (outcome.handover) {
    await client.chat.postMessage({
      channel: source.channelId,
      thread_ts: source.messageTs,
      text: outcome.handover,
    });
  }

  if (outcome.notice) {
    try {
      await applyNotice(client, outcome.notice, fire.id, clicker, source);
    } catch (error) {
      await report(error, "posting the reason");
    }
  }

  logger.info(`skip on \`${reminder.code}\` by ${clicker}`);
}
