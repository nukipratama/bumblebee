import type { App } from "@slack/bolt";
import { getSchedule, listRepos } from "../../../store/cf.js";
import { cfSettingsBlocks, type CfSettingsSummary } from "../../cf-blocks.js";

export function buildCfSummary(): CfSettingsSummary {
  return {
    repoNames: listRepos().map((repo) => repo.name),
    schedule: getSchedule(),
  };
}

export function registerCfSettings(app: App): void {
  app.command("/bee-cf-report", async ({ ack, respond, logger }) => {
    await ack();
    try {
      const summary = buildCfSummary();
      await respond({ text: "Code Freeze Report Configuration", blocks: cfSettingsBlocks(summary) });
    } catch (error) {
      logger.error("/bee-cf-report failed", error);
      await respond("Something went wrong. Check the logs.");
    }
  });
}
