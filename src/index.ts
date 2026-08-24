import { App, SocketModeReceiver } from "@slack/bolt";
import { startScheduler } from "./app/scheduler.js";
import { patchAckRetry } from "./app/socket-mode-ack-retry.js";
import { config } from "./config.js";
import { registerListeners } from "./slack/listeners/index.js";
import { initDb } from "./store/database.js";

const receiver = new SocketModeReceiver({
  appToken: config.slackAppToken,
  logLevel: config.logLevel,
});
patchAckRetry(receiver);

const app = new App({
  token: config.slackBotToken,
  appToken: config.slackAppToken,
  receiver,
  socketMode: true,
  logLevel: config.logLevel,
  extendedErrorHandler: true,
});

const errorHandler: Parameters<typeof app.error>[0] = async ({ error, body, logger }) => {
  const type = body && typeof body === "object" && "type" in body ? String(body.type) : "unknown";
  if ((error as { ackRetryExhausted?: boolean }).ackRetryExhausted) {
    logger.error(`ack retry exhausted for ${type} — likely a socket reconnect race`, error);
    return;
  }
  logger.error(`unhandled listener error for ${type}`, error);
};
app.error(errorHandler);

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
