import type { KnownBlock } from "@slack/web-api";
import {
  SQUADS,
  squadStatusLine,
  statusLabel,
  type CfMentionTarget,
  type CfResponse,
  type CfSchedule,
  type CfStatus,
  type Squad,
} from "../domain/cf.js";
import { escapeMrkdwn } from "./blocks.js";
import { formatDays, mention } from "./text.js";

export const CF_STATUS_ACTION = "cf_status_set";
export const CF_STATUS_ACTION_PATTERN = new RegExp(`^${CF_STATUS_ACTION}_`);
export const CF_EDIT_SETTINGS_ACTION = "cf_edit_settings";
export const CF_START_ACTION = "cf_start";
export const CF_REPO_REMOVE_ACTION = "cf_repo_remove";

/** Slack requires a unique `action_id` per interactive element in a message. */
function statusActionId(squad: Squad, status: CfStatus): string {
  return `${CF_STATUS_ACTION}_${squad.toLowerCase().replace(/\s+/g, "_")}_${status}`;
}

/** A button's `value`. The message/channel it belongs to comes from the click event itself. */
export interface CfButtonValue {
  squad: Squad;
  status: CfStatus;
}

const STATUSES: readonly CfStatus[] = ["all_merged", "no_mr"];

function responseFor(squad: Squad, responses: readonly CfResponse[]): CfResponse | undefined {
  return responses.find((response) => response.squad === squad);
}

/** A `section`'s accessory holds one element, so two buttons need their own `actions` block. */
function squadBlocks(squad: Squad, responses: readonly CfResponse[]): KnownBlock[] {
  return [
    { type: "section", text: { type: "mrkdwn", text: squadStatusLine(squad, responseFor(squad, responses)) } },
    {
      type: "actions",
      elements: STATUSES.map((status) => ({
        type: "button" as const,
        action_id: statusActionId(squad, status),
        text: { type: "plain_text" as const, text: statusLabel(status) },
        value: JSON.stringify({ squad, status } satisfies CfButtonValue),
        confirm: {
          title: { type: "plain_text" as const, text: "Confirm status" },
          text: { type: "mrkdwn" as const, text: `Set *${squad}* to *${statusLabel(status)}*?` },
          confirm: { type: "plain_text" as const, text: "Yes" },
          deny: { type: "plain_text" as const, text: "Cancel" },
        },
      })),
    },
  ];
}

function mentionText(target: CfMentionTarget): string {
  return target.kind === "user" ? mention(target.id) : `<!subteam^${target.id}>`;
}

export function cfRepoBlocks(
  repo: { name: string },
  responses: readonly CfResponse[],
  mentions: readonly CfMentionTarget[] = [],
): KnownBlock[] {
  const prefix = mentions.length > 0 ? `${mentions.map(mentionText).join(" ")} ` : "";
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${prefix}*Code Freeze Status* — \`${escapeMrkdwn(repo.name)}\`\nPlease report status of your Code Freeze (MR to develop) below.`,
      },
    },
    ...SQUADS.flatMap((squad) => squadBlocks(squad, responses)),
  ];
}

export function cfFallbackText(repo: { name: string }): string {
  return `Code Freeze Status — ${escapeMrkdwn(repo.name)}`;
}

export interface CfSettingsSummary {
  repoNames: readonly string[];
  schedule?: CfSchedule | undefined;
  mentions: readonly CfMentionTarget[];
}

function mentionLine(summary: CfSettingsSummary): string {
  return summary.mentions.length > 0
    ? `Mentions: ${summary.mentions.map(mentionText).join(" ")}`
    : "Mentions: not configured";
}

function scheduleLine(summary: CfSettingsSummary): string {
  if (!summary.schedule) return "Recurring: not configured";

  const { channelId, at, days, lastFiredDate } = summary.schedule;
  const lastRun = lastFiredDate ? ` — last run ${lastFiredDate}` : "";
  return `Recurring: every ${formatDays(days)} at ${at} (Asia/Jakarta), posts to <#${channelId}>${lastRun}`;
}

/** A `section`'s accessory holds one element — enough for a single Remove button. */
function repoRowBlocks(name: string): KnownBlock {
  return {
    type: "section",
    text: { type: "mrkdwn", text: `\`${escapeMrkdwn(name)}\`` },
    accessory: {
      type: "button",
      action_id: CF_REPO_REMOVE_ACTION,
      style: "danger",
      text: { type: "plain_text", text: "Remove" },
      value: name,
      confirm: {
        title: { type: "plain_text", text: "Remove repo" },
        text: {
          type: "mrkdwn",
          text: `Stop tracking \`${escapeMrkdwn(name)}\` in Code Freeze reports?`,
        },
        confirm: { type: "plain_text", text: "Remove" },
        deny: { type: "plain_text", text: "Cancel" },
      },
    },
  };
}

export function cfSettingsBlocks(summary: CfSettingsSummary): KnownBlock[] {
  const repoHeading =
    summary.repoNames.length > 0 ? "*Repos*" : "Repos: none configured";

  return [
    { type: "section", text: { type: "mrkdwn", text: "*Code Freeze Report Configuration*" } },
    { type: "section", text: { type: "mrkdwn", text: repoHeading } },
    ...summary.repoNames.map(repoRowBlocks),
    { type: "section", text: { type: "mrkdwn", text: mentionLine(summary) } },
    { type: "section", text: { type: "mrkdwn", text: scheduleLine(summary) } },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: CF_EDIT_SETTINGS_ACTION,
          text: { type: "plain_text", text: "Edit settings" },
        },
        {
          type: "button",
          action_id: CF_START_ACTION,
          style: "primary",
          text: { type: "plain_text", text: "Start now" },
          confirm: {
            title: { type: "plain_text", text: "Start Code Freeze round" },
            text: {
              type: "mrkdwn",
              text: "Post Code Freeze status for all configured repos to this channel?",
            },
            confirm: { type: "plain_text", text: "Start" },
            deny: { type: "plain_text", text: "Cancel" },
          },
        },
      ],
    },
  ];
}
