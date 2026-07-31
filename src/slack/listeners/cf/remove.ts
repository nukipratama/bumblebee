import type { App, BlockAction, ButtonAction } from "@slack/bolt";
import { removeRepo } from "../../../store/cf.js";
import { CF_REPO_REMOVE_ACTION, cfSettingsBlocks } from "../../cf-blocks.js";
import { buildCfSummary } from "./settings.js";

export function registerCfRepoRemove(app: App): void {
  app.action<BlockAction<ButtonAction>>(
    CF_REPO_REMOVE_ACTION,
    async ({ ack, body, client, logger }) => {
      await ack();

      const channelId = body.channel?.id;
      const name = body.actions[0]?.value;
      if (!channelId || !name) return;

      try {
        removeRepo(name);
        await client.chat.postMessage({
          channel: channelId,
          text: "Code Freeze Report Configuration",
          blocks: cfSettingsBlocks(buildCfSummary()),
        });
      } catch (error) {
        logger.error("removing a Code Freeze repo failed", error);
        await client.chat.postEphemeral({
          channel: channelId,
          user: body.user.id,
          text: "That didn't work. Check the logs.",
        });
      }
    },
  );
}
