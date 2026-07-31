import type { App } from "@slack/bolt";
import { registerCfMentionOptions } from "./mention-options.js";
import { registerCfSettingsForm } from "./modal.js";
import { registerCfRemoveConfig } from "./remove-config.js";
import { registerCfSettings } from "./settings.js";
import { registerCfStart } from "./start.js";
import { registerCfStatus } from "./status.js";

export function registerCf(app: App): void {
  registerCfSettings(app);
  registerCfSettingsForm(app);
  registerCfMentionOptions(app);
  registerCfRemoveConfig(app);
  registerCfStart(app);
  registerCfStatus(app);
}
