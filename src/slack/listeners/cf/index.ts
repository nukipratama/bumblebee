import type { App } from "@slack/bolt";
import { registerCfSettingsForm } from "./modal.js";
import { registerCfSettings } from "./settings.js";
import { registerCfStart } from "./start.js";
import { registerCfStatus } from "./status.js";

export function registerCf(app: App): void {
  registerCfSettings(app);
  registerCfSettingsForm(app);
  registerCfStart(app);
  registerCfStatus(app);
}
