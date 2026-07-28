export const DAY_NAMES = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

export type DayName = (typeof DAY_NAMES)[number];

export const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday"] as const;

export const EVERY_DAY = "*";

export const WEEKDAY_COLUMN = WEEKDAYS.join(",");

export function isDayName(value: string): value is DayName {
  return DAY_NAMES.includes(value as DayName);
}

export function dayMatches(days: string, day: string): boolean {
  return days === EVERY_DAY || days.split(",").includes(day);
}

export function daysColumn(chosen: ReadonlySet<string>): string {
  return DAY_NAMES.filter((day) => chosen.has(day)).join(",");
}

export function isEveryDay(chosen: ReadonlySet<string>): boolean {
  return chosen.size === DAY_NAMES.length;
}

export function isSingleDay(days: string): boolean {
  return days !== EVERY_DAY && !days.includes(",");
}
