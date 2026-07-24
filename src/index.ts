import { App } from "@slack/bolt";
import { config } from "./config.js";
import { register } from "./listeners/index.js";

const app = new App({
  token: config.slackBotToken,
  appToken: config.slackAppToken,
  socketMode: true,
  logLevel: config.logLevel,
});

register(app);

async function main(): Promise<void> {
  await app.start();
  console.log("⚡️ Bumblebee running (socket mode)");
}

main().catch((error) => {
  console.error("Failed to start Bumblebee:", error);
  process.exit(1);
});
