import type { Fire, Reminder } from "./types.js";

export const HANDOVER_GRACE_MS = 30 * 60_000;

/** Local, because `fired_on` is a date and the whole scheduler reads the local clock. */
export function meetingTimeMs(fire: Fire, reminder: Reminder): number {
  return new Date(`${fire.firedOn}T${reminder.at}:00`).getTime();
}

/**
 * Past this the meeting has effectively happened, and rewriting who was
 * responsible revises history. Measured from the meeting rather than the fire: a
 * reminder with a lead fires while nobody is in the call yet. Attendance has no
 * such limit — it changes nothing anyone acted on.
 */
export function hostChangeOpen(fire: Fire, reminder: Reminder, now: number): boolean {
  return now <= meetingTimeMs(fire, reminder) + HANDOVER_GRACE_MS;
}
