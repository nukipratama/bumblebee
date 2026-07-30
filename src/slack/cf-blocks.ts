import type { KnownBlock } from "@slack/web-api";
import {
  SQUADS,
  squadStatusLine,
  statusLabel,
  type CfResponse,
  type CfSchedule,
  type CfStatus,
  type Squad,
} from "../domain/cf.js";
import { escapeMrkdwn } from "./blocks.js";
import { formatDays } from "./text.js";

export const CF_STATUS_ACTION = "cf_status_set";
export const CF_EDIT_SETTINGS_ACTION = "cf_edit_settings";
export const CF_START_ACTION = "cf_start";

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
        action_id: CF_STATUS_ACTION,
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

export function cfRepoBlocks(repo: { name: string }, responses: readonly CfResponse[]): KnownBlock[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Code Freeze Status* — \`${escapeMrkdwn(repo.name)}\`\nPlease report status of your Code Freeze (MR to develop) below.`,
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
}

function scheduleLine(summary: CfSettingsSummary): string {
  if (!summary.schedule) return "Recurring: not configured";

  const { channelId, at, days, lastFiredDate } = summary.schedule;
  const lastRun = lastFiredDate ? ` — last run ${lastFiredDate}` : "";
  return `Recurring: every ${formatDays(days)} at ${at} (Asia/Jakarta), posts to <#${channelId}>${lastRun}`;
}

export function cfSettingsBlocks(summary: CfSettingsSummary): KnownBlock[] {
  const repoLine =
    summary.repoNames.length > 0
      ? summary.repoNames.map(escapeMrkdwn).join(", ")
      : "none configured";

  return [
    { type: "section", text: { type: "mrkdwn", text: "*Code Freeze Report Configuration*" } },
    { type: "section", text: { type: "mrkdwn", text: `Repos: ${repoLine}` } },
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
