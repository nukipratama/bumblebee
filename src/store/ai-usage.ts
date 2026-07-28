import { stmt } from "./database.js";

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

export function recordAiUsage(row: AiUsageRecord): void {
  stmt(
    `INSERT INTO ai_usage
       (slack_user_id, channel_id, model, prompt_tokens, completion_tokens, total_tokens)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    row.slackUserId ?? null,
    row.channelId ?? null,
    row.model,
    row.promptTokens,
    row.completionTokens,
    row.totalTokens,
  );
}

export function getAiUsageSummary(): AiUsageSummary {
  return stmt(
    `SELECT COUNT(*)                           AS requests,
            COALESCE(SUM(prompt_tokens), 0)     AS promptTokens,
            COALESCE(SUM(completion_tokens), 0) AS completionTokens,
            COALESCE(SUM(total_tokens), 0)      AS totalTokens,
            MIN(created_at)                     AS since
       FROM ai_usage`,
  ).get() as unknown as AiUsageSummary;
}
