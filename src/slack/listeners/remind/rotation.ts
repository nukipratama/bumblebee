import type { App, BlockAction, ButtonAction, UsersSelectAction } from "@slack/bolt";
import { hasHosted, pendingLap } from "../../../domain/rotation.js";
import { lastHostedOn, listHosts } from "../../../store/reminders.js";
import { HOST_NEXT_ACTION, HOST_SKIP_ACTION } from "../../blocks.js";
import { mention } from "../../text.js";
import { askFromRow, type Prompt } from "./prompt.js";

const NO_ROTATION = (code: string): Prompt => ({
  error: `\`${code}\` has no rotation — add one from *Edit*.`,
});

export function registerRotationActions(app: App): void {
  app.action<BlockAction<ButtonAction>>(
    HOST_SKIP_ACTION,
    async ({ ack, body, respond, logger }) => {
      await ack();
      const code = body.actions[0]!.value!;

      await askFromRow({ body, respond, logger }, code, (reminder) => {
        const roster = listHosts(reminder.id);
        if (roster.length === 0) return NO_ROTATION(code);
        if (roster.length === 1) {
          return { error: `there's only one person on \`${code}\` — nothing to skip to` };
        }

        const lap = pendingLap(roster);
        const upNext = lap[0]!;
        const after =
          lap.length > 1
            ? [
                `${mention(lap[1]!)} would be up next.`,
                "They keep their turn — they move to the back of this lap.",
              ]
            : [
                "They were last in this lap, so it rolls over and a fresh order is drawn.",
                "They keep their turn — everyone is pending again in the new lap.",
              ];

        return {
          summary: [`Skip ${mention(upNext)} on \`${code}\`?`, ...after].join("\n"),
          action: { kind: "hostSkip", code },
        };
      });
    },
  );

  app.action<BlockAction<UsersSelectAction>>(
    HOST_NEXT_ACTION,
    async ({ ack, body, respond, logger }) => {
      await ack();
      // A users_select carries no value of its own, so its block holds the code.
      const selected = body.actions[0]!;
      const code = selected.block_id;
      const userId = selected.selected_user!;

      await askFromRow({ body, respond, logger }, code, (reminder) => {
        const member = listHosts(reminder.id).find((entry) => entry.userId === userId);
        if (!member) {
          return { error: `${mention(userId)} is not on the rotation for \`${code}\`` };
        }

        const lines = [`Put ${mention(userId)} up next on \`${code}\`?`];
        if (hasHosted(member)) {
          const hostedOn = lastHostedOn(reminder.id).get(userId) ?? "earlier";
          lines.push(`They already hosted this lap on ${hostedOn}, so they'll host again.`);
        }

        return { summary: lines.join("\n"), action: { kind: "hostNext", code, userId } };
      });
    },
  );
}
