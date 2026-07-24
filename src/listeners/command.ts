import type { App } from "@slack/bolt";
import { getAiUsageSummary } from "../db/ai-usage.js";

const STATUS_LINE = "🐝 Bumblebee is online and reporting for duty. Roll out! ⚡️";

/** Format the AI-usage summary as a Slack markdown block. */
function formatUsage(): string {
  const { requests, promptTokens, completionTokens, totalTokens, since } =
    getAiUsageSummary();

  if (requests === 0) {
    return "*AI usage:* no requests recorded yet.";
  }

  return [
    "*AI usage*",
    `• requests: ${requests}`,
    `• tokens: ${totalTokens} (prompt ${promptTokens} / completion ${completionTokens})`,
    `• since: ${since}`,
  ].join("\n");
}

export function registerCommand(app: App): void {
  app.command("/bee-status", async ({ ack, respond, logger }) => {
    await ack();
    let body = STATUS_LINE;
    try {
      body += `\n\n${formatUsage()}`;
    } catch (error) {
      logger.error("Failed to read AI usage summary", error);
    }
    await respond(body);
  });
}
