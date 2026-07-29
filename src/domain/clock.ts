import { DAY_NAMES } from "./days.js";

const MONTHS_ARE_ZERO_INDEXED = 1;
const MS_PER_DAY = 86_400_000;

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

const MINUTES_PER_HOUR = 60;

export function minutesSinceMidnight(time: string): number {
  const [hours, minutes] = time.split(":").map(Number) as [number, number];
  return hours * MINUTES_PER_HOUR + minutes;
}

export function timeAtMinutes(minutes: number): string {
  return `${pad(Math.floor(minutes / MINUTES_PER_HOUR))}:${pad(minutes % MINUTES_PER_HOUR)}`;
}

export function daysBetween(earlier: string, later: string): number {
  return Math.round(
    (Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / MS_PER_DAY,
  );
}
