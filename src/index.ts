import { App } from "@slack/bolt";
import { startScheduler } from "./app/scheduler.js";
import { config } from "./config.js";
import { registerListeners } from "./slack/listeners/index.js";
import { initDb } from "./store/database.js";

const app = new App({
  token: config.slackBotToken,
  appToken: config.slackAppToken,
  socketMode: true,
  logLevel: config.logLevel,
});

registerListeners(app);

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
