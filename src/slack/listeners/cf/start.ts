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
        const result = await startCfRound(client, body.user.id, channelId);
        await respond(
          `🚀 Started a new Code Freeze round — posted ${result.repoCount} message(s) to this channel.`,
        );
      } catch (error) {
        logger.error("starting Code Freeze round failed", error);
        await respond("That didn't work. Check the logs.");
      }
    },
  );
}
