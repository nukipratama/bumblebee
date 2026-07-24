import type { StatementSync } from "node:sqlite";
import { db } from "./index.js";

export interface AiUsageRecord {
  slackUserId: string | undefined;
  channelId: string | undefined;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface AiUsageSummary {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  since: string | null;
}

// Statements are prepared lazily (memoized) rather than at module load, because
// the ai_usage table doesn't exist until initDb() runs its migrations at startup.
let insertStmt: StatementSync | undefined;
let summaryStmt: StatementSync | undefined;

function insert(): StatementSync {
  insertStmt ??= db.prepare(
    `INSERT INTO ai_usage
       (slack_user_id, channel_id, model, prompt_tokens, completion_tokens, total_tokens)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  return insertStmt;
}

function summary(): StatementSync {
  summaryStmt ??= db.prepare(
    `SELECT COUNT(*)                     AS requests,
            COALESCE(SUM(prompt_tokens), 0)     AS promptTokens,
            COALESCE(SUM(completion_tokens), 0) AS completionTokens,
            COALESCE(SUM(total_tokens), 0)      AS totalTokens,
            MIN(created_at)              AS since
       FROM ai_usage`,
  );
  return summaryStmt;
}

/** Insert one AI-usage row. */
export function recordAiUsage(row: AiUsageRecord): void {
  insert().run(
    row.slackUserId ?? null,
    row.channelId ?? null,
    row.model,
    row.promptTokens,
    row.completionTokens,
    row.totalTokens,
  );
}

/** Aggregate token usage across all recorded calls. */
export function getAiUsageSummary(): AiUsageSummary {
  return summary().get() as unknown as AiUsageSummary;
}
