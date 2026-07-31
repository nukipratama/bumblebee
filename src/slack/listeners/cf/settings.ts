import type { App } from "@slack/bolt";
import { getSchedule, listMentions, listRepos } from "../../../store/cf.js";
import { cfSettingsBlocks, type CfSettingsSummary } from "../../cf-blocks.js";

export function buildCfSummary(channelId: string): CfSettingsSummary {
  return {
    repos: listRepos(channelId),
    schedule: getSchedule(channelId),
    mentions: listMentions(channelId),
  };
}

export function registerCfSettings(app: App): void {
  app.command("/bee-cf-report", async ({ ack, command, respond, logger }) => {
    await ack();
    try {
      const summary = buildCfSummary(command.channel_id);
      await respond({ text: "Code Freeze Report Configuration", blocks: cfSettingsBlocks(summary) });
    } catch (error) {
      logger.error("/bee-cf-report failed", error);
      await respond("Something went wrong. Check the logs.");
    }
  });
}
