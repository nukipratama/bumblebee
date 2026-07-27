import type { App } from "@slack/bolt";
import { registerCommand } from "./command.js";
import { registerMention } from "./mention.js";
import { registerRemind } from "./remind.js";
import { registerShortcut } from "./shortcut.js";
import { registerSkip } from "./skip.js";

export function register(app: App): void {
  registerCommand(app);
  registerMention(app);
  registerRemind(app);
  registerShortcut(app);
  registerSkip(app);
}
