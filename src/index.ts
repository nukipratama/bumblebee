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

const app = new App({
  token: config.slackBotToken,
  appToken: config.slackAppToken,
  receiver,
  socketMode: true,
  logLevel: config.logLevel,
  extendedErrorHandler: true,
});

patchAckRetry(receiver, app.logger);

/** Slash commands carry `user_id`/`channel_id` flat; actions/views/shortcuts
 *  nest them as `user.id`/`channel.id`, plus an `actions[0].action_id`. Tries
 *  both shapes rather than assuming which kind of body triggered the retry. */
function describeActionContext(body: unknown): string {
  const record = body as Record<string, unknown>;
  const asId = (value: unknown): string | undefined =>
    typeof value === "object" && value !== null && "id" in value
      ? String((value as { id?: unknown }).id)
      : undefined;

  const actionId = Array.isArray(record?.actions)
    ? ((record.actions[0] as { action_id?: string } | undefined)?.action_id ?? undefined)
    : undefined;
  const userId = asId(record?.user) ?? (record?.user_id as string | undefined);
  const channelId = asId(record?.channel) ?? (record?.channel_id as string | undefined);

  const parts = [
    actionId ? `action=${actionId}` : undefined,
    userId ? `user=${userId}` : undefined,
    channelId ? `channel=${channelId}` : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? ` (${parts.join(" ")})` : "";
}

const errorHandler: Parameters<typeof app.error>[0] = async ({ error, body, logger }) => {
  const type = body && typeof body === "object" && "type" in body ? String(body.type) : "unknown";
  if ((error as { ackRetryExhausted?: boolean }).ackRetryExhausted) {
    logger.error(
      `ack retry exhausted for ${type}${describeActionContext(body)} — likely a socket reconnect race`,
      error,
    );
    return;
  }
  logger.error(`unhandled listener error for ${type}`, error);
};
app.error(errorHandler);

registerListeners(app);

function warnIfNotProduction(): void {
  if (process.env.NODE_ENV === "production") return;
  console.warn(
    "⚠️  NODE_ENV is not 'production' — if this connects with the same Slack tokens as the " +
      "deployed container, every reminder and Code Freeze post will go out twice into the " +
      "real channel. Use a scratch channel, or stop the container first.",
  );
}

async function main(): Promise<void> {
  warnIfNotProduction();
  initDb();
  await app.start();
  console.log("⚡️ Bumblebee running (socket mode)");
  const scheduler = startScheduler(app);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.logger.info(`${signal} received, shutting down`);
    await scheduler.stop();
    await app.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error) => {
  console.error("Failed to start Bumblebee:", error);
  process.exit(1);
});
