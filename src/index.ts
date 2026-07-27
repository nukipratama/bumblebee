import { App } from "@slack/bolt";
import { config } from "./config.js";
import { initDb } from "./db/index.js";
import { register } from "./listeners/index.js";
import { startScheduler } from "./scheduler/index.js";

const app = new App({
  token: config.slackBotToken,
  appToken: config.slackAppToken,
  socketMode: true,
  logLevel: config.logLevel,
});

register(app);

async function main(): Promise<void> {
  initDb();
  await app.start();
  console.log("⚡️ Bumblebee running (socket mode)");
  startScheduler(app);
}

main().catch((error) => {
  console.error("Failed to start Bumblebee:", error);
  process.exit(1);
});
