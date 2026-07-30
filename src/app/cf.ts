import type { WebClient } from "@slack/web-api";
import { cfFallbackText, cfRepoBlocks } from "../slack/cf-blocks.js";
import { listRepos, recordMessage, startRound } from "../store/cf.js";

export interface StartCfRoundResult {
  repoCount: number;
}

/**
 * `channelId` is the caller's — either the invoking command's channel (manual
 * Start now) or the recurring schedule's stored channel (scheduler tick).
 */
export async function startCfRound(
  client: WebClient,
  startedBy: string,
  channelId: string,
): Promise<StartCfRoundResult> {
  const repos = listRepos();
  const roundId = startRound(startedBy);

  for (const repo of repos) {
    const posted = await client.chat.postMessage({
      channel: channelId,
      blocks: cfRepoBlocks(repo, []),
      text: cfFallbackText(repo),
      unfurl_links: false,
      unfurl_media: false,
    });

    // Only a successful post gets recorded — same as fireReminder's recordFire.
    if (posted.ts) recordMessage(roundId, repo.id, channelId, posted.ts);
  }

  return { repoCount: repos.length };
}
