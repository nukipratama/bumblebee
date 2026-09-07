import { randomUUID } from "node:crypto";

const TTL_MS = 5 * 60_000;

/**
 * What a single click is allowed to do. Creating and editing are not here: a
 * form's submit is its own confirmation, so it writes directly.
 */
export type PendingAction =
  | { kind: "remove"; code: string }
  | { kind: "run"; code: string }
  | { kind: "holidayAdd"; date: string }
  | { kind: "holidayRemove"; date: string }
  | { kind: "hostSkip"; code: string }
  | { kind: "hostNext"; code: string; userId: string }
  | { kind: "hostCurrent"; code: string; userId: string };

/** One log line per applied confirmation, so a rotation change can be traced afterwards. */
export function describeAction(action: PendingAction): string {
  switch (action.kind) {
    case "remove":
    case "run":
    case "hostSkip":
      return `${action.kind} ${action.code}`;
    case "holidayAdd":
    case "holidayRemove":
      return `${action.kind} ${action.date}`;
    case "hostNext":
    case "hostCurrent":
      return `${action.kind} ${action.code} ${action.userId}`;
  }
}

export interface PendingEntry {
  action: PendingAction;
  userId: string;
  channelId: string;
  createdAt: number;
}

const entries = new Map<string, PendingEntry>();

/** Nobody clicking a button leaves its entry to expire quietly — swept here
 *  instead of on a timer, since a new entry is the only thing that needs one. */
function sweepExpired(now: number): void {
  for (const [id, entry] of entries) {
    if (now - entry.createdAt > TTL_MS) entries.delete(id);
  }
}

export function put(entry: Omit<PendingEntry, "createdAt">, now = Date.now()): string {
  sweepExpired(now);
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
