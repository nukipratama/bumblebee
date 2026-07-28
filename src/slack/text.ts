import { localParts } from "../domain/clock.js";
import { EVERY_DAY, WEEKDAY_COLUMN } from "../domain/days.js";
import { hasHosted } from "../domain/rotation.js";
import { formatCadence, nextFire } from "../domain/schedule.js";
import type { Host, Reminder } from "../domain/types.js";

export const mention = (userId: string): string => `<@${userId}>`;
export const mentionList = (userIds: readonly string[]): string => userIds.map(mention).join(", ");

export function formatDays(days: string): string {
  if (days === EVERY_DAY) return "daily";
  if (days === WEEKDAY_COLUMN) return "weekdays";
  return days.replaceAll(",", ", ");
}

export function formatRecurrence(reminder: Pick<Reminder, "days" | "everyNWeeks">): string {
  const cadence = reminder.everyNWeeks === 1 ? "" : ` · ${formatCadence(reminder.everyNWeeks)}`;
  return `${formatDays(reminder.days)}${cadence}`;
}

export function formatSchedule(reminder: Pick<Reminder, "at" | "days" | "everyNWeeks">): string {
  return `${reminder.at} · ${formatRecurrence(reminder)}`;
}

export function formatTimestamp(iso: string | null): string {
  if (!iso) return "never";
  const { date, time } = localParts(new Date(iso));
  return `${date} ${time}`;
}

export function formatNextFire(reminder: Reminder, holidays: ReadonlySet<string>): string {
  if (!reminder.enabled) return "paused";
  const next = nextFire(reminder, new Date(), (date) => holidays.has(date));
  return next ? formatTimestamp(next.toISOString()) : "nothing in the next 4 weeks";
}

/** The whole roster in lap order: who has been, who's up, who's to come. */
export function formatRotation(
  roster: readonly Host[],
  hostedOn: ReadonlyMap<string, string>,
): string | undefined {
  if (roster.length === 0) return undefined;

  const dateOf = (member: Host): string => hostedOn.get(member.userId) ?? "earlier";

  const hosted = roster
    .filter(hasHosted)
    .sort((a, b) => dateOf(a).localeCompare(dateOf(b)))
    .map((member) => `✓ ${mention(member.userId)}  hosted ${dateOf(member)}`);

  const pending = roster
    .filter((member) => !hasHosted(member))
    .map((member, index) =>
      index === 0 ? `→ ${mention(member.userId)}  up next` : `· ${mention(member.userId)}`,
    );

  return ["*rotation*", ...hosted, ...pending].join("\n");
}

/** A diff, not the resulting list — a dropped name is invisible in a list of who remains. */
export function formatRosterDiff(roster: readonly Host[], userIds: readonly string[]): string[] {
  const existingIds = new Set(roster.map((member) => member.userId));
  const added = userIds.filter((id) => !existingIds.has(id));
  const removed = roster.filter((member) => !userIds.includes(member.userId));
  const unchanged = userIds.filter((id) => existingIds.has(id));

  const note = (member: Host): string => (hasHosted(member) ? " (already hosted this lap)" : "");

  return [
    ...added.map((id) => `+ ${mention(id)}`),
    ...removed.map((member) => `− ${mention(member.userId)}${note(member)}`),
    ...(unchanged.length > 0 ? [`unchanged: ${mentionList(unchanged)}`] : []),
  ];
}
