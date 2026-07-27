import type { App } from "@slack/bolt";
import { registerCommand } from "./command.js";
import { registerMention } from "./mention.js";
import { registerRemind } from "./remind.js";

export function register(app: App): void {
  registerCommand(app);
  registerMention(app);
  registerRemind(app);
}
