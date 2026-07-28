import type { KnownBlock } from "@slack/web-api";
import type { BodyFormat } from "../domain/types.js";

export const SKIP_ACTION = "reminder_skip";
export const APPROVE_ACTION = "remind_approve";
export const REJECT_ACTION = "remind_reject";

export interface ReminderPost {
  body: string;
  bodyFormat: BodyFormat;
  host?: string;
  hostUnavailable?: boolean;
  outToday: readonly string[];
  skippable: boolean;
  windowClosed: boolean;
}

const mention = (userId: string): string => `<@${userId}>`;

/** Each dialect goes through the block that reads it as written. Never convert. */
function bodyBlock(post: ReminderPost): KnownBlock {
  return post.bodyFormat === "mrkdwn"
    ? { type: "section", text: { type: "mrkdwn", text: post.body } }
    : { type: "markdown", text: post.body };
}

/** Rebuilt from scratch every time, because `chat.update` replaces blocks wholesale. */
export function reminderBlocks(post: ReminderPost): KnownBlock[] {
  const blocks: KnownBlock[] = [bodyBlock(post)];

  const context: string[] = [];
  if (post.host) context.push(`🎙 Host: ${mention(post.host)}`);
  else if (post.hostUnavailable) context.push("⚠️ Nobody available to host today");
  if (post.outToday.length > 0) {
    context.push(`🚪 Out today: ${post.outToday.map(mention).join(", ")}`);
  }
  if (context.length > 0) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: context.join("\n") }],
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

/** Without this a blocks-only message reads as "This content can't be displayed". */
export function fallbackText(post: ReminderPost): string {
  const host = post.host ? ` — host ${mention(post.host)}` : "";
  return `${post.body}${host}`;
}

export function confirmBlocks(summary: string, pendingId: string): KnownBlock[] {
  return [
    { type: "section", text: { type: "mrkdwn", text: summary } },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: APPROVE_ACTION,
          style: "primary",
          text: { type: "plain_text", text: "Approve" },
          value: pendingId,
        },
        {
          type: "button",
          action_id: REJECT_ACTION,
          style: "danger",
          text: { type: "plain_text", text: "Reject" },
          value: pendingId,
        },
      ],
    },
  ];
}
