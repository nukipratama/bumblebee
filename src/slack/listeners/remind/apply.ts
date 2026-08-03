import type { Logger } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { fireReminder } from "../../../app/fire.js";
import { drawLapAvoiding, moveToBack, moveToFront, pendingLap } from "../../../domain/rotation.js";
import { repost } from "../../repost.js";
import {
  deleteHoliday,
  deleteReminder,
  getHoliday,
  getReminder,
  insertHoliday,
  listHolidayDates,
  listHosts,
  setFireHost,
  setLap,
} from "../../../store/reminders.js";
import type { PendingEntry } from "../../pending.js";
import { formatNextFire, mention } from "../../text.js";
import { checkHostCurrent } from "./hostCurrent.js";

export interface ApplyResult {
  ephemeral: string;
  channel?: string;
}

const gone = (code: string, verb = "changed"): ApplyResult => ({
  ephemeral: `\`${code}\` no longer exists — nothing ${verb}`,
});

function applyRemove(entry: PendingEntry, code: string): ApplyResult {
  if (!getReminder(entry.channelId, code)) return gone(code, "removed");

  deleteReminder(entry.channelId, code);
  return {
    ephemeral: `Removed \`${code}\`.`,
    channel: `${mention(entry.userId)} removed reminder \`${code}\``,
  };
}

async function applyRun(
  entry: PendingEntry,
  code: string,
  client: WebClient,
): Promise<ApplyResult> {
  const existing = getReminder(entry.channelId, code);
  if (!existing) return gone(code, "posted");

  // Rehearses what the tick would do next: a reminder with a lead fires the heads-up.
  const outcome = await fireReminder(
    existing,
    client,
    existing.leadMinutes > 0 ? "heads-up" : "meeting",
  );
  if (outcome.posted) {
    const host = outcome.host ? ` Host was ${mention(outcome.host)}, and their turn is used.` : "";
    return { ephemeral: `Posted \`${code}\`.${host}` };
  }

  const whenNext = `\nNext fire: ${formatNextFire(existing, listHolidayDates())}`;
  return { ephemeral: `Skipped \`${code}\`: ${outcome.reason}.${whenNext}` };
}

function applyHolidayAdd(entry: PendingEntry, date: string): ApplyResult {
  if (getHoliday(date)) return { ephemeral: `\`${date}\` is already a holiday` };

  insertHoliday({ date, addedBy: entry.userId, addedInChannel: entry.channelId });
  return {
    ephemeral: `Added holiday \`${date}\`.`,
    channel: `${mention(entry.userId)} added holiday \`${date}\` — reminders skip it in every channel`,
  };
}

function applyHolidayRemove(entry: PendingEntry, date: string): ApplyResult {
  if (!getHoliday(date)) return { ephemeral: `\`${date}\` is not a holiday` };

  deleteHoliday(date);
  return {
    ephemeral: `Removed holiday \`${date}\`.`,
    channel: `${mention(entry.userId)} removed holiday \`${date}\``,
  };
}

function applyHostSkip(entry: PendingEntry, code: string): ApplyResult {
  const reminder = getReminder(entry.channelId, code);
  if (!reminder) return gone(code);

  const roster = listHosts(reminder.id);
  const rosterIds = roster.map((member) => member.userId);
  if (rosterIds.length < 2) {
    return { ephemeral: `\`${code}\` no longer has enough people to skip — nothing changed` };
  }

  const lap = pendingLap(roster);
  const skipped = lap[0]!;
  const next = lap.length > 1 ? moveToBack(lap, skipped) : drawLapAvoiding(rosterIds, skipped);
  setLap(reminder.id, next);

  return {
    ephemeral: `Skipped ${mention(skipped)} on \`${code}\`.`,
    channel: `${mention(entry.userId)} skipped ${mention(skipped)} on \`${code}\` — ${mention(next[0]!)} is up next`,
  };
}

function applyHostNext(entry: PendingEntry, code: string, userId: string): ApplyResult {
  const reminder = getReminder(entry.channelId, code);
  if (!reminder) return gone(code);

  const roster = listHosts(reminder.id);
  if (!roster.some((member) => member.userId === userId)) {
    return { ephemeral: `${mention(userId)} is no longer on \`${code}\` — nothing changed` };
  }

  setLap(reminder.id, moveToFront(pendingLap(roster), userId));
  return {
    ephemeral: `${mention(userId)} is up next on \`${code}\`.`,
    channel: `${mention(entry.userId)} put ${mention(userId)} up next on \`${code}\``,
  };
}

async function applyHostCurrent(
  entry: PendingEntry,
  code: string,
  userId: string,
  client: WebClient,
  logger: Logger,
): Promise<ApplyResult> {
  const reminder = getReminder(entry.channelId, code);
  if (!reminder) return gone(code);

  const check = checkHostCurrent(reminder, userId, Date.now());
  if ("error" in check) return { ephemeral: check.error };

  setFireHost(check.fire.id, userId);
  const updated = { ...check.fire, hostUserId: userId };

  try {
    await repost(client, updated, reminder, entry.channelId);
  } catch (error) {
    logger.error("updating the post failed", error);
    return {
      ephemeral: `${mention(userId)} is now hosting \`${code}\`, but I couldn't update the live post — it may have been deleted.`,
    };
  }

  return {
    ephemeral: `${mention(userId)} is now hosting \`${code}\`.`,
    channel: `${mention(entry.userId)} set ${mention(userId)} as the current host for \`${code}\``,
  };
}

/** Every branch re-reads current state, because it can change between the prompt and the click. */
export async function applyAction(
  entry: PendingEntry,
  client: WebClient,
  logger: Logger,
): Promise<ApplyResult> {
  const { action } = entry;

  switch (action.kind) {
    case "remove":
      return applyRemove(entry, action.code);
    case "run":
      return applyRun(entry, action.code, client);
    case "holidayAdd":
      return applyHolidayAdd(entry, action.date);
    case "holidayRemove":
      return applyHolidayRemove(entry, action.date);
    case "hostSkip":
      return applyHostSkip(entry, action.code);
    case "hostNext":
      return applyHostNext(entry, action.code, action.userId);
    case "hostCurrent":
      return applyHostCurrent(entry, action.code, action.userId, client, logger);
  }
}
