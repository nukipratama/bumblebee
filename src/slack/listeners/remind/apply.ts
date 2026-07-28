import type { WebClient } from "@slack/web-api";
import { fireReminder } from "../../../app/fire.js";
import { drawLapAvoiding, moveToBack, moveToFront, pendingLap, planLap } from "../../../domain/rotation.js";
import { cadenceFitsDays } from "../../../domain/schedule.js";
import type { NewReminder, ReminderChanges } from "../../../domain/types.js";
import {
  clearHosts,
  deleteHoliday,
  deleteReminder,
  getHoliday,
  getReminder,
  insertHoliday,
  insertReminder,
  listHolidayDates,
  listHosts,
  replaceHosts,
  setLap,
  setReminderAt,
  setReminderCadence,
  setReminderDays,
  setReminderMessage,
} from "../../../store/reminders.js";
import type { PendingEntry } from "../../pending.js";
import { formatNextFire, formatSchedule, mention, mentionList } from "../../text.js";

export interface ApplyResult {
  ephemeral: string;
  channel?: string;
}

const gone = (code: string, verb = "changed"): ApplyResult => ({
  ephemeral: `\`${code}\` no longer exists — nothing ${verb}`,
});

function applyAdd(entry: PendingEntry, reminder: NewReminder): ApplyResult {
  if (getReminder(entry.channelId, reminder.code)) {
    return { ephemeral: `\`${reminder.code}\` already exists now — nothing added` };
  }

  insertReminder(reminder);
  return {
    ephemeral: `Added \`${reminder.code}\`.`,
    channel: `${mention(entry.userId)} added reminder \`${reminder.code}\` — ${formatSchedule(reminder)}`,
  };
}

function applyEdit(entry: PendingEntry, code: string, changes: ReminderChanges): ApplyResult {
  const existing = getReminder(entry.channelId, code);
  if (!existing) return gone(code);

  const merged = { ...existing, ...changes };
  const fits = cadenceFitsDays(merged.everyNWeeks, merged.days);
  if (!fits.ok) {
    return {
      ephemeral: `\`${code}\` changed since you asked — ${fits.error}. Nothing changed; run \`edit\` again.`,
    };
  }

  const { at, days, message, everyNWeeks } = changes;
  if (at !== undefined) setReminderAt(entry.channelId, code, at);
  if (days !== undefined) setReminderDays(entry.channelId, code, days);
  if (message !== undefined) setReminderMessage(entry.channelId, code, message);
  if (everyNWeeks !== undefined) setReminderCadence(entry.channelId, code, everyNWeeks);

  const updated = getReminder(entry.channelId, code)!;
  return {
    ephemeral: `Updated \`${code}\`.`,
    channel: `${mention(entry.userId)} edited reminder \`${code}\` — now ${formatSchedule(updated)}`,
  };
}

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

  const outcome = await fireReminder(existing, client);
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

function applyHostSet(entry: PendingEntry, code: string, userIds: string[]): ApplyResult {
  const reminder = getReminder(entry.channelId, code);
  if (!reminder) return gone(code);

  replaceHosts(reminder.id, userIds, planLap(listHosts(reminder.id), userIds));
  const upNext = pendingLap(listHosts(reminder.id))[0];

  return {
    ephemeral: `Rotation for \`${code}\` set — ${userIds.length} people.`,
    channel:
      `${mention(entry.userId)} set the rotation for \`${code}\` — ${mentionList(userIds)}` +
      (upNext ? `. ${mention(upNext)} is up next` : ""),
  };
}

function applyHostClear(entry: PendingEntry, code: string): ApplyResult {
  const reminder = getReminder(entry.channelId, code);
  if (!reminder) return gone(code);

  clearHosts(reminder.id);
  return {
    ephemeral: `Rotation removed from \`${code}\`.`,
    channel: `${mention(entry.userId)} removed the rotation from \`${code}\``,
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

/** Every branch re-reads current state, because it can change between the prompt and the click. */
export async function applyAction(entry: PendingEntry, client: WebClient): Promise<ApplyResult> {
  const { action } = entry;

  switch (action.kind) {
    case "add":
      return applyAdd(entry, action.reminder);
    case "edit":
      return applyEdit(entry, action.code, action.changes);
    case "remove":
      return applyRemove(entry, action.code);
    case "run":
      return applyRun(entry, action.code, client);
    case "holidayAdd":
      return applyHolidayAdd(entry, action.date);
    case "holidayRemove":
      return applyHolidayRemove(entry, action.date);
    case "hostSet":
      return applyHostSet(entry, action.code, action.userIds);
    case "hostClear":
      return applyHostClear(entry, action.code);
    case "hostSkip":
      return applyHostSkip(entry, action.code);
    case "hostNext":
      return applyHostNext(entry, action.code, action.userId);
  }
}
