import type { App, BlockAction, ButtonAction } from "@slack/bolt";
import { startCfRound } from "../../../app/cf.js";
import { CF_START_ACTION } from "../../cf-blocks.js";

export function registerCfStart(app: App): void {
  app.action<BlockAction<ButtonAction>>(
    CF_START_ACTION,
    async ({ ack, body, client, respond, logger }) => {
      await ack();
      const channelId = body.channel?.id;
      if (!channelId) return;

      try {
        const result = await startCfRound(client, body.user.id, channelId, logger);
        const posted = result.repoCount - result.failedRepos.length;
        const failedNames = result.failedRepos.map((name) => `\`${name}\``).join(", ");
        const failureNote = result.failedRepos.length > 0 ? ` — failed for ${failedNames}, check the logs.` : "";
        await respond(
          `🚀 Started a new Code Freeze round — posted ${posted} message(s) to this channel.${failureNote}`,
        );
      } catch (error) {
        logger.error("starting Code Freeze round failed", error);
        await respond("That didn't work. Check the logs.");
      }
    },
  );
}
