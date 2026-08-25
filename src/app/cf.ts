import { WebAPIRateLimitedError, type WebClient } from "@slack/web-api";
import type { Logger } from "@slack/bolt";
import { cfFallbackText, cfRepoBlocks } from "../slack/cf-blocks.js";
import { listMentions, listRepos, recordMessage, startRound } from "../store/cf.js";

export interface StartCfRoundResult {
  repoCount: number;
  /** Repos whose post failed — the round still went out for everyone else. */
  failedRepos: string[];
}

/**
 * `channelId` is the caller's — either the invoking command's channel (manual
 * Start now) or the recurring schedule's stored channel (scheduler tick). Each
 * repo posts independently, so one failure (rate limit, `channel_not_found`)
 * doesn't take the rest of the round down with it.
 */
export async function startCfRound(
  client: WebClient,
  startedBy: string,
  channelId: string,
  logger?: Logger,
): Promise<StartCfRoundResult> {
  const repos = listRepos(channelId);
  const roundId = startRound(startedBy);
  const mentions = listMentions(channelId);

  const failedRepos: string[] = [];
  for (const repo of repos) {
    try {
      const posted = await client.chat.postMessage({
        channel: channelId,
        blocks: cfRepoBlocks(repo, [], mentions),
        text: cfFallbackText(repo),
        unfurl_links: false,
        unfurl_media: false,
      });

      // Only a successful post gets recorded — same as fireReminder's recordFire.
      if (posted.ts) recordMessage(roundId, repo.id, channelId, posted.ts, repo.squads);
    } catch (error) {
      const rateLimited =
        error instanceof WebAPIRateLimitedError ? ` (rate limited, retry after ${error.retryAfter}s)` : "";
      logger?.error(`Code Freeze post failed for repo \`${repo.name}\`${rateLimited}`, error);
      failedRepos.push(repo.name);
    }
  }

  return { repoCount: repos.length, failedRepos };
}
