import type { KnownBlock } from "@slack/web-api";
import type { BodyFormat, Reminder, Skip } from "../domain/types.js";

export const SKIP_ACTION = "reminder_skip";
export const APPROVE_ACTION = "remind_approve";
export const REJECT_ACTION = "remind_reject";
export const NEW_REMINDER_ACTION = "remind_new";
export const EDIT_REMINDER_ACTION = "remind_edit";
export const RUN_REMINDER_ACTION = "remind_run";
export const REMOVE_REMINDER_ACTION = "remind_remove";
export const HOST_SKIP_ACTION = "remind_host_skip";
export const HOST_NEXT_ACTION = "remind_host_next";

export interface ReminderPost {
  code: string;
  body: string;
  bodyFormat: BodyFormat;
  host?: string;
  hostUnavailable?: boolean;
  skips: readonly Skip[];
  skippable: boolean;
}

/**
 * Which of a reminder's two posts a card is. Only the body differs, so a repaint
 * has to know which message it is rewriting or it would overwrite the heads-up
 * with the meeting body.
 */
export type PostBody = "heads-up" | "meeting";

/**
 * The heads-up prefix is applied here rather than stored, or editing a reminder
 * would prepend a second copy. A lead with no pre-message falls back to the
 * meeting body instead of posting a bare prefix.
 */
export function reminderBody(
  reminder: Pick<Reminder, "at" | "message" | "bodyFormat" | "preMessage">,
  which: PostBody,
): Pick<ReminderPost, "body" | "bodyFormat"> {
  if (which === "meeting" || reminder.preMessage === null) {
    return { body: reminder.message, bodyFormat: reminder.bodyFormat };
  }
  return { body: `Heads Up at ${reminder.at}: ${reminder.preMessage}`, bodyFormat: "markdown" };
}

const mention = (userId: string): string => `<@${userId}>`;

/** A reason is typed literally, so `<!channel>` in one must not become a ping. */
function escapeMrkdwn(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function skipLine(skip: Skip): string {
  const reason = skip.reason ? ` - ${escapeMrkdwn(skip.reason)}` : "";
  return `• ${mention(skip.userId)}${reason}`;
}

/** One line each: a reason runs long, and comma-joining would bury whose it is. */
function skipList(skips: readonly Skip[]): string {
  return ["🔕 Skip:", ...skips.map(skipLine)].join("\n");
}

/** Each dialect goes through the block that reads it as written. Never convert. */
function bodyBlock(post: ReminderPost): KnownBlock {
  return post.bodyFormat === "mrkdwn"
    ? { type: "section", text: { type: "mrkdwn", text: post.body } }
    : { type: "markdown", text: post.body };
}

/** Rebuilt from scratch every time, because `chat.update` replaces blocks wholesale. */
export function reminderBlocks(post: ReminderPost): KnownBlock[] {
  const blocks: KnownBlock[] = [bodyBlock(post)];

  // Always present: without it a post gives no way back to the reminder that made it.
  const context: string[] = [`⚙️ \`${post.code}\``];
  if (post.host) context.push(`🎙 Host: ${mention(post.host)}`);
  else if (post.hostUnavailable) context.push("⚠️ Nobody available to host");
  if (post.skips.length > 0) context.push(skipList(post.skips));

  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: context.join("\n") }],
  });

  if (post.skippable) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: SKIP_ACTION,
          text: { type: "plain_text", text: "Skip me" },
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

export interface ReminderDetail {
  code: string;
  body: string;
  /** Absent when the reminder has no roster, which is also when the lap controls make no sense. */
  rotation?: string;
}

export function reminderDetailBlocks(detail: ReminderDetail): KnownBlock[] {
  const blocks: KnownBlock[] = [{ type: "section", text: { type: "mrkdwn", text: detail.body } }];
  if (!detail.rotation) return blocks;

  blocks.push({ type: "section", text: { type: "mrkdwn", text: detail.rotation } });
  blocks.push({
    type: "actions",
    // A users_select has no value of its own, so the code rides on the block.
    block_id: detail.code,
    elements: [
      {
        type: "button",
        action_id: HOST_SKIP_ACTION,
        text: { type: "plain_text", text: "Skip host" },
        value: detail.code,
      },
      {
        type: "users_select",
        action_id: HOST_NEXT_ACTION,
        placeholder: { type: "plain_text", text: "Put someone up next" },
      },
    ],
  });

  return blocks;
}

export const HOLIDAY_ADD_ACTION = "remind_holiday_add";
export const HOLIDAY_REMOVE_ACTION = "remind_holiday_remove";

export interface HolidayRow {
  date: string;
  addedBy: string;
  addedInChannel: string;
}

/** One block per row here, so the ceiling is higher than the reminder list's. */
const MAX_HOLIDAY_ROWS = 45;

export function holidayListBlocks(rows: readonly HolidayRow[], footer: string): KnownBlock[] {
  const shown = rows.slice(0, MAX_HOLIDAY_ROWS);
  const hidden = rows.slice(MAX_HOLIDAY_ROWS);

  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: rows.length === 0 ? "No holidays recorded." : "*Holidays*" },
    },
    ...shown.map(
      (row): KnownBlock => ({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `\`${row.date}\` — added by <@${row.addedBy}> in <#${row.addedInChannel}>`,
        },
        accessory: {
          type: "button",
          action_id: HOLIDAY_REMOVE_ACTION,
          style: "danger",
          text: { type: "plain_text", text: "Remove" },
          value: row.date,
        },
      }),
    ),
    ...(hidden.length > 0
      ? [
          {
            type: "context" as const,
            elements: [
              {
                type: "mrkdwn" as const,
                text: `${hidden.length} more, without buttons: ${hidden
                  .map((row) => `\`${row.date}\``)
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
          type: "datepicker",
          action_id: HOLIDAY_ADD_ACTION,
          placeholder: { type: "plain_text", text: "Add a holiday" },
        },
      ],
    },
    { type: "context", elements: [{ type: "mrkdwn", text: footer }] },
  ];
}
