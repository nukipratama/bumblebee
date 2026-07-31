import type { CfMentionTarget, CfRepo, CfResponse, CfSchedule, CfStatus } from "../domain/cf.js";
import { stmt, transaction } from "./database.js";

export function listRepos(): CfRepo[] {
  return stmt("SELECT id, name FROM cf_repos WHERE active = 1 ORDER BY name").all() as unknown as CfRepo[];
}

export function getRepoById(id: number): CfRepo | undefined {
  return stmt("SELECT id, name FROM cf_repos WHERE id = ?").get(id) as unknown as CfRepo | undefined;
}

/** Deactivates everything first, then reactivates/creates exactly what was submitted. */
export function replaceRepos(names: readonly string[]): void {
  transaction(() => {
    stmt("UPDATE cf_repos SET active = 0").run();
    const upsert = stmt(
      `INSERT INTO cf_repos (name, active, created_at)
       VALUES (?, 1, ?)
       ON CONFLICT (name) DO UPDATE SET active = 1`,
    );
    const createdAt = new Date().toISOString();
    for (const name of names) upsert.run(name, createdAt);
  });
}

/** Soft-deactivate, same as replaceRepos — past rounds still reference this repo by id. */
export function removeRepo(name: string): void {
  stmt("UPDATE cf_repos SET active = 0 WHERE name = ?").run(name);
}

export function getSchedule(): CfSchedule | undefined {
  return stmt(
    `SELECT channel_id AS channelId, at_time AS at, days, last_fired_date AS lastFiredDate
       FROM cf_schedule WHERE id = 1`,
  ).get() as unknown as CfSchedule | undefined;
}

export function setSchedule(channelId: string, at: string, days: string): void {
  stmt(
    `INSERT INTO cf_schedule (id, channel_id, at_time, days, last_fired_date)
     VALUES (1, ?, ?, ?, NULL)
     ON CONFLICT (id) DO UPDATE SET
       channel_id = excluded.channel_id,
       at_time    = excluded.at_time,
       days       = excluded.days`,
  ).run(channelId, at, days);
}

export function clearSchedule(): void {
  stmt("DELETE FROM cf_schedule WHERE id = 1").run();
}

export function setScheduleLastFiredDate(date: string): void {
  stmt("UPDATE cf_schedule SET last_fired_date = ? WHERE id = 1").run(date);
}

export function listMentions(): CfMentionTarget[] {
  return stmt("SELECT kind, target_id AS id, handle FROM cf_mentions ORDER BY kind, id").all() as unknown as CfMentionTarget[];
}

/** No `active` flag on this table, so a replace is a plain delete-and-reinsert. */
export function replaceMentions(targets: readonly CfMentionTarget[]): void {
  transaction(() => {
    stmt("DELETE FROM cf_mentions").run();
    const insert = stmt("INSERT INTO cf_mentions (kind, target_id, handle) VALUES (?, ?, ?)");
    for (const target of targets) insert.run(target.kind, target.id, target.handle ?? null);
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
