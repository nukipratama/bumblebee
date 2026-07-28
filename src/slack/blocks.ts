import type { KnownBlock } from "@slack/web-api";
import type { BodyFormat } from "../domain/types.js";

export const SKIP_ACTION = "reminder_skip";
export const APPROVE_ACTION = "remind_approve";
export const REJECT_ACTION = "remind_reject";
export const NEW_REMINDER_ACTION = "remind_new";
export const EDIT_REMINDER_ACTION = "remind_edit";
export const RUN_REMINDER_ACTION = "remind_run";
export const REMOVE_REMINDER_ACTION = "remind_remove";

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

export interface ReminderRow {
  code: string;
  at: string;
  recurrence: string;
}

/**
 * Slack caps a message at 50 blocks and every row costs two, so past this many
 * the list would be rejected outright rather than truncated. The overflow is
 * named in a footnote instead of vanishing.
 */
const MAX_BUTTON_ROWS = 23;

const rowBlocks = (row: ReminderRow): KnownBlock[] => [
  {
    type: "section",
    text: { type: "mrkdwn", text: `\`${row.at}\`  \`${row.code}\`  ${row.recurrence}` },
  },
  {
    type: "actions",
    elements: [
      {
        type: "button",
        action_id: EDIT_REMINDER_ACTION,
        text: { type: "plain_text", text: "Edit" },
        value: row.code,
      },
      {
        type: "button",
        action_id: RUN_REMINDER_ACTION,
        text: { type: "plain_text", text: "Run now" },
        value: row.code,
      },
      {
        type: "button",
        action_id: REMOVE_REMINDER_ACTION,
        style: "danger",
        text: { type: "plain_text", text: "Remove" },
        value: row.code,
      },
    ],
  },
];

/**
 * Rows carry their own code, because a click tells us nothing but the button's
 * value. An empty channel still gets the button — it is the only way to create
 * a reminder that isn't built from an existing message.
 */
export function reminderListBlocks(rows: readonly ReminderRow[]): KnownBlock[] {
  const heading =
    rows.length === 0 ? "No reminders in this channel yet." : "*Reminders in this channel*";
  const shown = rows.slice(0, MAX_BUTTON_ROWS);
  const hidden = rows.slice(MAX_BUTTON_ROWS);

  return [
    { type: "section", text: { type: "mrkdwn", text: heading } },
    ...shown.flatMap(rowBlocks),
    ...(hidden.length > 0
      ? [
          {
            type: "context" as const,
            elements: [
              {
                type: "mrkdwn" as const,
                text: `${hidden.length} more, without buttons: ${hidden
                  .map((row) => `\`${row.code}\``)
                  .join(", ")}`,
              },
            ],
          },
        ]
      : []),
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: NEW_REMINDER_ACTION,
          style: "primary",
          text: { type: "plain_text", text: "+ New reminder" },
        },
      ],
    },
  ];
}
