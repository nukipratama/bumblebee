import { daysBetween, localParts, type WallClock } from "./clock.js";
import { dayMatches, isSingleDay } from "./days.js";
import { fail, ok, type Parsed } from "./result.js";
import type { Reminder } from "./types.js";

const EVERY_WEEK = 1;
const DAYS_PER_WEEK = 7;
const SEARCH_LIMIT_DAYS = 28;

export function formatCadence(everyNWeeks: number): string {
  return everyNWeeks === EVERY_WEEK ? "every week" : `every ${everyNWeeks} weeks`;
}

export function matches(reminder: Reminder, now: Pick<WallClock, "time" | "day">): boolean {
  return reminder.at === now.time && dayMatches(reminder.days, now.day);
}

export function requiredDaysSinceLastFire(everyNWeeks: number): number {
  return DAYS_PER_WEEK * everyNWeeks - 1;
}

export function cadenceOk(reminder: Reminder, date: string): boolean {
  if (reminder.everyNWeeks === EVERY_WEEK || !reminder.lastFiredAt) return true;

  const lastFiredDate = localParts(new Date(reminder.lastFiredAt)).date;
  return daysBetween(lastFiredDate, date) >= requiredDaysSinceLastFire(reminder.everyNWeeks);
}

export function cadenceFitsDays(everyNWeeks: number, days: string): Parsed<true> {
  if (everyNWeeks === EVERY_WEEK || isSingleDay(days)) return ok(true);

  return fail(
    `${formatCadence(everyNWeeks)} needs exactly one day in \`--on\` — the gap is measured ` +
      "in days, so several days would post once per cycle rather than on each day",
  );
}

function atTimeOnDay(from: Date, dayOffset: number, at: string): Date {
  const [hours, minutes] = at.split(":").map(Number) as [number, number];
  const candidate = new Date(from);
  candidate.setDate(candidate.getDate() + dayOffset);
  candidate.setHours(hours, minutes, 0, 0);
  return candidate;
}

export function nextFire(
  reminder: Reminder,
  from: Date,
  isHoliday: (date: string) => boolean,
): Date | null {
  for (let dayOffset = 0; dayOffset <= SEARCH_LIMIT_DAYS; dayOffset++) {
    const candidate = atTimeOnDay(from, dayOffset, reminder.at);
    if (candidate <= from) continue;

    const { day, date } = localParts(candidate);
    if (!dayMatches(reminder.days, day)) continue;
    if (isHoliday(date)) continue;
    if (!cadenceOk(reminder, date)) continue;

    return candidate;
  }
  return null;
}
