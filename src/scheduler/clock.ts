import type { Logger } from "@slack/bolt";

const DAY_NAMES = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

const JAKARTA_UTC_OFFSET_MINUTES = 420;
const MONTHS_ARE_ZERO_INDEXED = 1;
const MINUTES_PER_HOUR = 60;

export interface WallClock {
  time: string;
  day: string;
  date: string;
}

const pad = (value: number): string => String(value).padStart(2, "0");

export function localParts(date: Date): WallClock {
  return {
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
    day: DAY_NAMES[date.getDay()]!,
    date: `${date.getFullYear()}-${pad(date.getMonth() + MONTHS_ARE_ZERO_INDEXED)}-${pad(date.getDate())}`,
  };
}

export function daysBetween(earlier: string, later: string): number {
  const MS_PER_DAY = 86_400_000;
  return Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / MS_PER_DAY);
}

export function assertJakarta(logger: Logger): void {
  const offsetMinutes = -new Date().getTimezoneOffset();
  if (offsetMinutes === JAKARTA_UTC_OFFSET_MINUTES) return;

  logger.error(
    `TZ misconfigured: expected UTC+7 (Asia/Jakarta), got ` +
      `UTC${offsetMinutes >= 0 ? "+" : ""}${offsetMinutes / MINUTES_PER_HOUR}. ` +
      `Reminders will fire at the wrong time. ` +
      `Check that the image has tzdata installed and TZ=Asia/Jakarta is set.`,
  );
}
