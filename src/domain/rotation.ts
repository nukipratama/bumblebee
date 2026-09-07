import type { Host } from "./types.js";

/** Fisher–Yates. A random comparator passed to `sort` is measurably biased on a small rota. */
export function shuffle<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    [result[index], result[swap]] = [result[swap]!, result[index]!];
  }
  return result;
}

export function drawLap(
  userIds: readonly string[],
  pinFirst?: string,
  random: () => number = Math.random,
): string[] {
  if (pinFirst === undefined || !userIds.includes(pinFirst)) return shuffle(userIds, random);

  return [pinFirst, ...shuffle(userIds.filter((id) => id !== pinFirst), random)];
}

export function moveToFront(order: readonly string[], userId: string): string[] {
  return [userId, ...order.filter((id) => id !== userId)];
}

export function moveToBack(order: readonly string[], userId: string): string[] {
  return [...order.filter((id) => id !== userId), userId];
}

export interface TurnSwap {
  lap: string[];
  turnUserId: string | null;
}

/**
 * Hands the turn `charged` paid for to `standIn`. `charged` rejoins at the back, as a
 * handover's clicker does. A `standIn` who already hosted this lap is not in `lap` and so
 * pays nothing — the day costs the rotation no turn at all.
 */
export function swapTurn(
  lap: readonly string[],
  standIn: string,
  charged: string | null,
): TurnSwap {
  const withoutStandIn = lap.filter((id) => id !== standIn);
  const returns = charged !== null && !withoutStandIn.includes(charged);

  return {
    lap: returns ? [...withoutStandIn, charged!] : withoutStandIn,
    turnUserId: lap.includes(standIn) ? standIn : null,
  };
}

/**
 * Moving the only pending member to the back is a no-op, so a closing lap rolls
 * over instead — and rolling straight back onto them would make `skip` appear to
 * do nothing.
 */
export function drawLapAvoiding(
  userIds: readonly string[],
  avoid: string,
  random: () => number = Math.random,
): string[] {
  const lap = drawLap(userIds, undefined, random);
  if (lap.length > 1 && lap[0] === avoid) [lap[0], lap[1]] = [lap[1]!, lap[0]!];
  return lap;
}

export function hasHosted(member: Host): boolean {
  return member.lapOrder === null;
}

/**
 * The roster is a set; the lap is the ordered thing. Re-planning a lap redraws
 * it, so the caller needs to know the membership is untouched before deciding
 * whether to redraw at all.
 */
export function sameRoster(existing: readonly Host[], userIds: readonly string[]): boolean {
  const members = new Set(existing.map((member) => member.userId));
  const chosen = new Set(userIds);

  return members.size === chosen.size && [...chosen].every((userId) => members.has(userId));
}

/** Assumes `roster` is sorted hosted-first-then-pending, as `listHosts` returns it. */
export function pendingLap(roster: readonly Host[]): string[] {
  return roster.filter((member) => !hasHosted(member)).map((member) => member.userId);
}

/**
 * Anyone who already hosted this lap stays hosted, so correcting a typo cannot
 * hand someone a second turn. Everyone still pending keeps the place they hold
 * now — an edit that adds or drops one person must not reshuffle the queue the
 * rest have already read off `show` — and newcomers are drawn in behind them. A
 * roster whose members have all hosted starts a fresh lap.
 */
export function planLap(
  existing: readonly Host[],
  userIds: readonly string[],
  random: () => number = Math.random,
): string[] {
  const hosted = new Set(existing.filter(hasHosted).map((member) => member.userId));
  const pendingNow = existing
    .filter((member) => !hasHosted(member))
    .sort((a, b) => a.lapOrder! - b.lapOrder!)
    .map((member) => member.userId);

  const chosen = new Set(userIds);
  const keeping = pendingNow.filter((id) => chosen.has(id));
  const joining = userIds.filter((id) => !hosted.has(id) && !pendingNow.includes(id));

  if (keeping.length === 0 && joining.length === 0) return drawLap(userIds, undefined, random);
  return [...keeping, ...shuffle(joining, random)];
}
