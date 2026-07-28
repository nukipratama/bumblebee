import type { BlockAction, BlockElementAction, Logger } from "@slack/bolt";
import type { KnownBlock } from "@slack/web-api";
import type { Reminder } from "../../../domain/types.js";
import { getReminder } from "../../../store/reminders.js";
import { confirmBlocks } from "../../blocks.js";
import { put, type PendingAction } from "../../pending.js";

export interface RowActionArgs {
  body: BlockAction<BlockElementAction>;
  respond: (message: { text: string; blocks?: KnownBlock[] }) => Promise<unknown>;
  logger: Logger;
}

/** Either a confirmation to raise, or why there is nothing to confirm. */
export type Prompt = { summary: string; action: PendingAction } | { error: string };

/**
 * A button composes the same request its command used to. The prompt is a new
 * ephemeral rather than a replacement, so whatever it was clicked from — a
 * list, a rotation — is still there afterwards.
 */
export async function askFromRow(
  { body, respond, logger }: RowActionArgs,
  code: string,
  build: (reminder: Reminder) => Prompt,
): Promise<void> {
  try {
    const channelId = body.channel!.id;

    const reminder = getReminder(channelId, code);
    if (!reminder) {
      await respond({ text: `\`${code}\` no longer exists — nothing to do.` });
      return;
    }

    const prompt = build(reminder);
    if ("error" in prompt) {
      await respond({ text: prompt.error });
      return;
    }

    const pendingId = put({ action: prompt.action, userId: body.user.id, channelId });
    await respond({ text: prompt.summary, blocks: confirmBlocks(prompt.summary, pendingId) });
  } catch (error) {
    logger.error("row action failed", error);
  }
}
