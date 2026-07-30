import type { App } from "@slack/bolt";
import { registerRemind } from "./remind/index.js";
import { registerShortcut } from "./shortcut.js";
import { registerSkip } from "./skip.js";
import { registerStatus } from "./status.js";

export function registerListeners(app: App): void {
  registerStatus(app);
  registerRemind(app);
  registerShortcut(app);
  registerSkip(app);
}
