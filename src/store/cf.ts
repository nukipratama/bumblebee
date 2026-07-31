import type { CfMentionTarget, CfRepo, CfResponse, CfSchedule, CfStatus } from "../domain/cf.js";
import { stmt, transaction } from "./database.js";

export function listRepos(channelId: string): CfRepo[] {
  return stmt("SELECT id, name FROM cf_repos WHERE channel_id = ? AND active = 1 ORDER BY name").all(
    channelId,
  ) as unknown as CfRepo[];
}

export function getRepoById(id: number): CfRepo | undefined {
  return stmt("SELECT id, name FROM cf_repos WHERE id = ?").get(id) as unknown as CfRepo | undefined;
}

/** Deactivates this channel's repos first, then reactivates/creates exactly what was submitted. */
export function replaceRepos(channelId: string, names: readonly string[]): void {
  transaction(() => {
    stmt("UPDATE cf_repos SET active = 0 WHERE channel_id = ?").run(channelId);
    const upsert = stmt(
      `INSERT INTO cf_repos (channel_id, name, active, created_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT (channel_id, name) DO UPDATE SET active = 1`,
    );
    const createdAt = new Date().toISOString();
    for (const name of names) upsert.run(channelId, name, createdAt);
  });
}

export function getSchedule(channelId: string): CfSchedule | undefined {
  return stmt(
    `SELECT channel_id AS channelId, at_time AS at, days, last_fired_date AS lastFiredDate
       FROM cf_schedule WHERE channel_id = ?`,
  ).get(channelId) as unknown as CfSchedule | undefined;
}

export function listSchedules(): CfSchedule[] {
  return stmt(
    `SELECT channel_id AS channelId, at_time AS at, days, last_fired_date AS lastFiredDate
       FROM cf_schedule ORDER BY channel_id`,
  ).all() as unknown as CfSchedule[];
}

export function setSchedule(channelId: string, at: string, days: string): void {
  stmt(
    `INSERT INTO cf_schedule (channel_id, at_time, days, last_fired_date)
     VALUES (?, ?, ?, NULL)
     ON CONFLICT (channel_id) DO UPDATE SET
       at_time = excluded.at_time,
       days    = excluded.days`,
  ).run(channelId, at, days);
}

export function clearSchedule(channelId: string): void {
  stmt("DELETE FROM cf_schedule WHERE channel_id = ?").run(channelId);
}

export function setScheduleLastFiredDate(channelId: string, date: string): void {
  stmt("UPDATE cf_schedule SET last_fired_date = ? WHERE channel_id = ?").run(date, channelId);
}

export function listMentions(channelId: string): CfMentionTarget[] {
  return stmt(
    "SELECT kind, target_id AS id, handle FROM cf_mentions WHERE channel_id = ? ORDER BY kind, id",
  ).all(channelId) as unknown as CfMentionTarget[];
}

/** No `active` flag on this table, so a replace is a plain delete-and-reinsert. */
export function replaceMentions(channelId: string, targets: readonly CfMentionTarget[]): void {
  transaction(() => {
    stmt("DELETE FROM cf_mentions WHERE channel_id = ?").run(channelId);
    const insert = stmt(
      "INSERT INTO cf_mentions (channel_id, kind, target_id, handle) VALUES (?, ?, ?, ?)",
    );
    for (const target of targets) insert.run(channelId, target.kind, target.id, target.handle ?? null);
  });
}

/** Repos soft-deactivated (past rounds still reference them); mentions and schedule dropped outright. */
export function clearChannelConfig(channelId: string): void {
  transaction(() => {
    stmt("UPDATE cf_repos SET active = 0 WHERE channel_id = ?").run(channelId);
    stmt("DELETE FROM cf_mentions WHERE channel_id = ?").run(channelId);
    stmt("DELETE FROM cf_schedule WHERE channel_id = ?").run(channelId);
  });
}

export function startRound(startedBy: string): number {
  const result = stmt("INSERT INTO cf_rounds (started_by, started_at) VALUES (?, ?)").run(
    startedBy,
    new Date().toISOString(),
  );
  return Number(result.lastInsertRowid);
}

export function recordMessage(
  roundId: number,
  repoId: number,
  channelId: string,
  messageTs: string,
): void {
  stmt(
    `INSERT INTO cf_messages (round_id, repo_id, channel_id, message_ts) VALUES (?, ?, ?, ?)`,
  ).run(roundId, repoId, channelId, messageTs);
}

export interface CfMessageRef {
  id: number;
  repoId: number;
}

export function getMessageByTs(messageTs: string): CfMessageRef | undefined {
  return stmt("SELECT id, repo_id AS repoId FROM cf_messages WHERE message_ts = ?").get(
    messageTs,
  ) as unknown as CfMessageRef | undefined;
}

/**
 * Only the latest click per squad is ever shown, so a re-click overwrites via
 * upsert rather than piling up rows.
 */
export function upsertResponse(
  messageId: number,
  squad: string,
  status: CfStatus,
  userId: string,
): void {
  stmt(
    `INSERT INTO cf_responses (message_id, squad, status, responded_by, responded_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (message_id, squad) DO UPDATE SET
       status       = excluded.status,
       responded_by = excluded.responded_by,
       responded_at = excluded.responded_at`,
  ).run(messageId, squad, status, userId, new Date().toISOString());
}

export function getResponses(messageId: number): CfResponse[] {
  return stmt(
    "SELECT squad, status, responded_by AS respondedBy FROM cf_responses WHERE message_id = ?",
  ).all(messageId) as unknown as CfResponse[];
}
