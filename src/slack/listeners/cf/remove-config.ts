import type { App, BlockAction, ButtonAction } from "@slack/bolt";
import { clearChannelConfig } from "../../../store/cf.js";
import { CF_REMOVE_CONFIG_ACTION, cfSettingsBlocks, describeCfSettingsChange } from "../../cf-blocks.js";
import { buildCfSummary } from "./settings.js";

export function registerCfRemoveConfig(app: App): void {
  app.action<BlockAction<ButtonAction>>(
    CF_REMOVE_CONFIG_ACTION,
    async ({ ack, body, client, logger }) => {
      await ack();
      const channelId = body.channel?.id;
      if (!channelId) return;

      try {
        const before = buildCfSummary(channelId);
        clearChannelConfig(channelId);
        const after = buildCfSummary(channelId);

        const change = describeCfSettingsChange(body.user.id, before, after);
        if (change) await client.chat.postMessage({ channel: channelId, text: change });

        await client.chat.postEphemeral({
          channel: channelId,
          user: body.user.id,
          text: "Code Freeze Report Configuration",
          blocks: cfSettingsBlocks(after),
        });
      } catch (error) {
        logger.error("removing the Code Freeze configuration failed", error);
        await client.chat.postEphemeral({
          channel: channelId,
          user: body.user.id,
          text: "That didn't work. Check the logs.",
        });
      }
    },
  );
}
