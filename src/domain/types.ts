/**
 * Which markup flavour `message` is written in. `*word*` is italic in Markdown
 * and bold in mrkdwn, so a body is rendered through the block that reads it as
 * written — never converted.
 */
export type BodyFormat = "markdown" | "mrkdwn";

export interface Reminder {
  id: number;
  channelId: string;
  code: string;
  at: string;
  days: string;
  message: string;
  bodyFormat: BodyFormat;
  everyNWeeks: number;
  enabled: boolean;
  lastFiredAt: string | null;
  createdBy: string;
  createdAt: string;
}

export interface NewReminder {
  channelId: string;
  code: string;
  at: string;
  days: string;
  message: string;
  bodyFormat: BodyFormat;
  everyNWeeks: number;
  createdBy: string;
}

export interface ReminderChanges {
  at?: string;
  days?: string;
  message?: string;
  everyNWeeks?: number;
}

export interface Holiday {
  date: string;
  addedBy: string;
  addedInChannel: string;
  addedAt: string;
}

/** `lapOrder` is their place in the current lap, or null once they have hosted it. */
export interface Host {
  userId: string;
  lapOrder: number | null;
}

export interface Fire {
  id: number;
  reminderId: number;
  firedOn: string;
  firedAt: string;
  hostUserId: string | null;
  messageTs: string | null;
}

export interface NewFire {
  reminderId: number;
  firedOn: string;
  firedAt: Date;
  hostUserId: string | null;
  messageTs: string | null;
  nextLap: readonly string[];
}
