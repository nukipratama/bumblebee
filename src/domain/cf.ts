export const SQUADS = ["SS", "LIMO", "Core BE", "Core FE"] as const;
export type Squad = (typeof SQUADS)[number];

export type CfStatus = "all_merged" | "no_mr";

export interface CfRepo {
  id: number;
  name: string;
  squads: readonly Squad[];
}

export function isSquad(value: string): value is Squad {
  return (SQUADS as readonly string[]).includes(value);
}

export function squadsColumn(chosen: readonly Squad[]): string | null {
  if (chosen.length === 0 || chosen.length === SQUADS.length) return null;
  const set = new Set(chosen);
  return SQUADS.filter((squad) => set.has(squad)).join(",");
}

export function squadsFromColumn(column: string | null): readonly Squad[] {
  if (!column) return SQUADS;
  return column.split(",").filter(isSquad);
}

/** `at`/`days` match `Reminder`'s field names so `domain/schedule.ts#matches` reads either. */
export interface CfSchedule {
  channelId: string;
  at: string;
  days: string;
  lastFiredDate: string | null;
}

export interface CfResponse {
  squad: string;
  status: CfStatus;
  respondedBy: string;
}

export type CfMentionKind = "user" | "usergroup";

/** `handle` is only ever set for a usergroup — a user mention needs no lookup. */
export interface CfMentionTarget {
  kind: CfMentionKind;
  id: string;
  handle?: string;
}

export function statusLabel(status: CfStatus): string {
  return status === "all_merged" ? "All Merged" : "No MR";
}

export function statusEmoji(status: CfStatus): string {
  return status === "all_merged" ? "✅" : "❌";
}

/** One bulleted line per squad: current status if reported, or a waiting placeholder. */
export function squadStatusLine(squad: Squad, response: CfResponse | undefined): string {
  if (!response) return `• *${squad}* — _not yet reported_`;
  return `• *${squad}* — ${statusEmoji(response.status)} ${statusLabel(response.status)} (<@${response.respondedBy}>)`;
}
