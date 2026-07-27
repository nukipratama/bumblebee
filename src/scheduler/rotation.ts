/**
 * Lap ordering for reminder host rotation. Plain arrays in, plain arrays out —
 * no database, no Slack client, and `random` is injectable so the shuffle can
 * be asserted exactly.
 */

/** Fisher–Yates. A random comparator passed to `sort` is measurably biased on a small rota. */
export function shuffle<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    [result[index], result[swap]] = [result[swap]!, result[index]!];
  }
  return result;
}

/** A fresh lap. `pinFirst` keeps whoever was already up at the head — see `host set`. */
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

/**
 * A fresh lap that cannot open with `avoid`. This is what `skip` needs when the
 * lap had one person left: moving them to the back of a one-item list is a
 * no-op, so the lap rolls over instead — and rolling straight back onto them
 * would make the command appear to do nothing.
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

export interface LapMember {
  userId: string;
  lapOrder: number | null;
}

export function hasHosted(member: LapMember): boolean {
  return member.lapOrder === null;
}

/** The pending lap, in order — assumes `roster` is sorted hosted-first-then-pending, as `listHosts` returns it. */
export function pendingLap(roster: readonly LapMember[]): string[] {
  return roster.filter((member) => !hasHosted(member)).map((member) => member.userId);
}

/**
 * The lap to store after `host set` replaces the roster with `userIds`.
 *
 * Anyone who already hosted this lap stays hosted, so correcting a typo cannot
 * hand someone a second turn. Whoever was up stays up if they survived the
 * change; the rest is re-drawn. A roster whose members have all hosted starts a
 * fresh lap rather than leaving nobody pending.
 */
export function planLap(
  existing: readonly LapMember[],
  userIds: readonly string[],
  random: () => number = Math.random,
): string[] {
  const hosted = new Set(
    existing.filter((member) => member.lapOrder === null).map((member) => member.userId),
  );
  const upNext = existing
    .filter((member) => member.lapOrder !== null)
    .sort((a, b) => a.lapOrder! - b.lapOrder!)[0]?.userId;

  const pending = userIds.filter((id) => !hosted.has(id));
  return pending.length > 0 ? drawLap(pending, upNext, random) : drawLap(userIds, undefined, random);
}
