import type { App, BlockAction, ButtonAction, Logger } from "@slack/bolt";
import type { KnownBlock, WebClient } from "@slack/web-api";
import type { Reminder } from "../../../domain/types.js";
import { getReminder } from "../../../store/reminders.js";
import {
  APPROVE_ACTION,
  REJECT_ACTION,
  REMOVE_REMINDER_ACTION,
  RUN_REMINDER_ACTION,
  confirmBlocks,
} from "../../blocks.js";
import { parseArgs, type FlagSpec } from "../../args.js";
import { put, takeIfFreshAndOwnedBy, type PendingAction } from "../../pending.js";
import { formatSchedule } from "../../text.js";
import { applyAction } from "./apply.js";
import { unwrap, type CommandContext } from "./context.js";
import { HELP_TEXT } from "./help.js";
import { handleHoliday } from "./holidays.js";
import { handleHost } from "./hosts.js";
import { registerReminderForm } from "./modal.js";
import { handleList, handleShow } from "./reminders.js";

/** The schedule lives on the form now; what is left takes a code and nothing else. */
const FLAG_SPEC: FlagSpec = { withValue: [], boolean: [] };

async function dispatch(ctx: CommandContext, text: string): Promise<void> {
  const trimmed = text.trim();
  const boundary = trimmed.indexOf(" ");
  const subcommand = boundary === -1 ? trimmed : trimmed.slice(0, boundary);
  const rest = boundary === -1 ? "" : trimmed.slice(boundary + 1);

  if (subcommand === "" || subcommand === "help") {
    await ctx.respond(HELP_TEXT);
    return;
  }
  if (subcommand === "holiday") {
    await handleHoliday(ctx, rest);
    return;
  }
  if (subcommand === "host") {
    await handleHost(ctx, rest);
    return;
  }
  if (subcommand === "list") {
    await handleList(ctx);
    return;
  }

  const args = await unwrap(ctx, parseArgs(rest, FLAG_SPEC));
  if (args === undefined) return;

  if (subcommand === "show") {
    await handleShow(ctx, args);
    return;
  }
  await ctx.respond(`unknown subcommand \`${subcommand}\` — try \`/bee-remind help\``);
}

interface RowActionArgs {
  body: BlockAction<ButtonAction>;
  respond: (message: { text: string; blocks?: KnownBlock[] }) => Promise<unknown>;
  logger: Logger;
}

/**
 * A row button composes the same request the command used to. The prompt is a
 * new ephemeral rather than a replacement, so the list it was clicked from
 * survives the confirmation.
 */
async function askFromRow(
  { body, respond, logger }: RowActionArgs,
  build: (reminder: Reminder) => { summary: string; action: PendingAction },
): Promise<void> {
  try {
    const channelId = body.channel!.id;
    const code = body.actions[0]!.value!;

    const reminder = getReminder(channelId, code);
    if (!reminder) {
      await respond({ text: `\`${code}\` no longer exists — nothing to do.` });
      return;
    }

    const { summary, action } = build(reminder);
    const pendingId = put({ action, userId: body.user.id, channelId });
    await respond({ text: summary, blocks: confirmBlocks(summary, pendingId) });
  } catch (error) {
    logger.error("row action failed", error);
  }
}

interface ConfirmationArgs {
  approved: boolean;
  body: BlockAction<ButtonAction>;
  respond: (message: { text: string; replace_original: true }) => Promise<unknown>;
  client: WebClient;
  logger: Logger;
}

async function resolveConfirmation({
  approved,
  body,
  respond,
  client,
  logger,
}: ConfirmationArgs): Promise<void> {
  const pendingId = body.actions[0]?.value;
  const entry = pendingId ? takeIfFreshAndOwnedBy(pendingId, body.user.id) : undefined;

  if (!entry) {
    await respond({
      replace_original: true,
      text: "That confirmation expired — run the command again.",
    });
    return;
  }

  if (!approved) {
    await respond({ replace_original: true, text: "Cancelled — nothing changed." });
    return;
  }

  try {
    const result = await applyAction(entry, client);
    await respond({ replace_original: true, text: result.ephemeral });
    if (result.channel) {
      await client.chat.postMessage({ channel: entry.channelId, text: result.channel });
    }
  } catch (error) {
    logger.error("confirmation failed to apply", error);
    await respond({ replace_original: true, text: "That didn't work. Check the logs." });
  }
}

export function registerRemind(app: App): void {
  registerReminderForm(app);

  app.command("/bee-remind", async ({ ack, command, respond, logger }) => {
    await ack();

    if (command.channel_id.startsWith("D")) {
      await respond("Use `/bee-remind` in a channel — reminders belong to a channel.");
      return;
    }

    const ctx: CommandContext = {
      channelId: command.channel_id,
      userId: command.user_id,
      respond: (text, blocks) => respond(blocks ? { text, blocks } : text),
      ask: async (summary, action) => {
        const pendingId = put({
          action,
          userId: command.user_id,
          channelId: command.channel_id,
        });
        await respond({ text: summary, blocks: confirmBlocks(summary, pendingId) });
      },
    };

    try {
      await dispatch(ctx, command.text ?? "");
    } catch (error) {
      logger.error("/bee-remind failed", error);
      await respond("Something went wrong. Check the logs.");
    }
  });

  app.action<BlockAction<ButtonAction>>(
    RUN_REMINDER_ACTION,
    async ({ ack, body, respond, logger }) => {
      await ack();
      await askFromRow({ body, respond, logger }, (reminder) => ({
        summary: `Post \`${reminder.code}\` to this channel now?\n\n${reminder.message}`,
        action: { kind: "run", code: reminder.code },
      }));
    },
  );

  app.action<BlockAction<ButtonAction>>(
    REMOVE_REMINDER_ACTION,
    async ({ ack, body, respond, logger }) => {
      await ack();
      await askFromRow({ body, respond, logger }, (reminder) => ({
        summary: `Remove \`${reminder.code}\`?  ${formatSchedule(reminder)}\nThis cannot be undone.`,
        action: { kind: "remove", code: reminder.code },
      }));
    },
  );

  app.action<BlockAction<ButtonAction>>(
    APPROVE_ACTION,
    async ({ ack, body, respond, client, logger }) => {
      await ack();
      await resolveConfirmation({ approved: true, body, respond, client, logger });
    },
  );

  app.action<BlockAction<ButtonAction>>(
    REJECT_ACTION,
    async ({ ack, body, respond, client, logger }) => {
      await ack();
      await resolveConfirmation({ approved: false, body, respond, client, logger });
    },
  );
}
