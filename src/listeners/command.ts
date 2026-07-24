import type { App } from "@slack/bolt";

export function registerCommand(app: App): void {
  app.command("/bumblebee", async ({ ack, respond }) => {
    await ack();
    await respond("🐝 Bumblebee is online and reporting for duty. Roll out! ⚡️");
  });
}
