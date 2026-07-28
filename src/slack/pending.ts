import { randomUUID } from "node:crypto";
import type { NewReminder, ReminderChanges } from "../domain/types.js";

const TTL_MS = 5 * 60_000;

export type PendingAction =
  | { kind: "add"; reminder: NewReminder }
  | { kind: "edit"; code: string; changes: ReminderChanges }
  | { kind: "remove"; code: string }
  | { kind: "setEnabled"; code: string; enabled: boolean }
  | { kind: "run"; code: string }
  | { kind: "holidayAdd"; date: string }
  | { kind: "holidayRemove"; date: string }
  | { kind: "hostSet"; code: string; userIds: string[] }
  | { kind: "hostClear"; code: string }
  | { kind: "hostSkip"; code: string }
  | { kind: "hostNext"; code: string; userId: string };

export interface PendingEntry {
  action: PendingAction;
  userId: string;
  channelId: string;
  createdAt: number;
}

const entries = new Map<string, PendingEntry>();

export function put(entry: Omit<PendingEntry, "createdAt">, now = Date.now()): string {
  const id = randomUUID();
  entries.set(id, { ...entry, createdAt: now });
  return id;
}

export function takeIfFreshAndOwnedBy(
  id: string,
  userId: string,
  now = Date.now(),
): PendingEntry | undefined {
  const entry = entries.get(id);
  if (!entry) return undefined;

  entries.delete(id);
  if (entry.userId !== userId) return undefined;
  if (now - entry.createdAt > TTL_MS) return undefined;

  return entry;
}
