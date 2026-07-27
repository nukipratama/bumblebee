import type { KnownBlock } from "@slack/web-api";
import type { BodyFormat } from "../db/reminders.js";

export const SKIP_ACTION = "reminder_skip";

/** Everything a reminder post shows, at any point in its life. */
export interface ReminderPost {
  body: string;
  bodyFormat: BodyFormat;
  host?: string;
  outToday: readonly string[];
  skippable: boolean;
  windowClosed: boolean;
}

const mention = (userId: string): string => `<@${userId}>`;

/**
 * The two markup flavours read the same characters differently — `*word*` is
 * italic in Markdown and bold in mrkdwn — so each body goes through the block
 * that reads it as written. Never convert between them.
 */
function bodyBlock(post: ReminderPost): KnownBlock {
  return post.bodyFormat === "mrkdwn"
    ? { type: "section", text: { type: "mrkdwn", text: post.body } }
    : { type: "markdown", text: post.body };
}

/**
 * The whole post, rebuilt from scratch every time. `chat.update` replaces blocks
 * wholesale, so a skip re-renders rather than patching — which is what stops the
 * post drifting into a shape only one code path knows how to produce.
 */
export function reminderBlocks(post: ReminderPost): KnownBlock[] {
  const blocks: KnownBlock[] = [bodyBlock(post)];

  const context: string[] = [];
  if (post.host) context.push(`🎙 Host: ${mention(post.host)}`);
  if (post.outToday.length > 0) {
    context.push(`🗓 Out today: ${post.outToday.map(mention).join(", ")}`);
  }
  if (context.length > 0) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: context.join("  ·  ") }],
    });
  }

  if (post.skippable) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: SKIP_ACTION,
          text: {
            type: "plain_text",
            text: post.windowClosed ? "Skip closed" : "Skip today",
          },
          value: post.windowClosed ? "closed" : "open",
        },
      ],
    });
  }

  return blocks;
}

/**
 * Notification and accessibility text. Blocks alone leave a message showing as
 * "This content can't be displayed" in notifications and to screen readers.
 */
export function fallbackText(post: ReminderPost): string {
  const host = post.host ? ` — host ${mention(post.host)}` : "";
  return `${post.body}${host}`;
}
