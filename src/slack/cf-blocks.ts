import type { KnownBlock } from "@slack/web-api";
import {
  SQUADS,
  squadStatusLine,
  type CfMentionTarget,
  type CfRepo,
  type CfResponse,
  type CfSchedule,
  type Squad,
} from "../domain/cf.js";
import { escapeMrkdwn } from "./blocks.js";
import { formatDays, mention } from "./text.js";

export const CF_STATUS_OPEN_ACTION = "cf_status_open";
export const CF_STATUS_OPEN_ACTION_PATTERN = new RegExp(`^${CF_STATUS_OPEN_ACTION}_`);
export const CF_EDIT_SETTINGS_ACTION = "cf_edit_settings";
export const CF_START_ACTION = "cf_start";
export const CF_REMOVE_CONFIG_ACTION = "cf_remove_config";

/** Slack requires a unique `action_id` per interactive element in a message. */
function squadSlug(squad: Squad): string {
  return squad.toLowerCase().replace(/\s+/g, "_");
}

function openActionId(squad: Squad): string {
  return `${CF_STATUS_OPEN_ACTION}_${squadSlug(squad)}`;
}

function responseFor(squad: Squad, responses: readonly CfResponse[]): CfResponse | undefined {
  return responses.find((response) => response.squad === squad);
}

function squadSection(squad: Squad, responses: readonly CfResponse[]): KnownBlock {
  return { type: "section", text: { type: "mrkdwn", text: squadStatusLine(squad, responseFor(squad, responses)) } };
}

/** One button per squad, opening a modal to report that squad's status. */
function squadButtonsBlock(squads: readonly Squad[]): KnownBlock {
  return {
    type: "actions",
    elements: squads.map((squad) => ({
      type: "button" as const,
      action_id: openActionId(squad),
      text: { type: "plain_text" as const, text: squad },
      value: squad,
    })),
  };
}

function mentionText(target: CfMentionTarget): string {
  return target.kind === "user" ? mention(target.id) : `<!subteam^${target.id}>`;
}

export function cfRepoBlocks(
  repo: { name: string; squads: readonly Squad[] },
  responses: readonly CfResponse[],
  mentions: readonly CfMentionTarget[] = [],
): KnownBlock[] {
  const prefix = mentions.length > 0 ? `${mentions.map(mentionText).join(" ")} ` : "";
  return [
    { type: "header", text: { type: "plain_text", text: `Code Freeze Status — ${repo.name}` } },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${prefix}Please report status of your Code Freeze (MR to develop) below.`,
      },
    },
    ...repo.squads.map((squad) => squadSection(squad, responses)),
    squadButtonsBlock(repo.squads),
  ];
}

export function cfFallbackText(repo: { name: string }): string {
  return `Code Freeze Status — ${escapeMrkdwn(repo.name)}`;
}

export interface CfSettingsSummary {
  repos: readonly CfRepo[];
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

function describeRepo(repo: CfRepo): string {
  const name = escapeMrkdwn(repo.name);
  return repo.squads.length === SQUADS.length ? name : `${name} (${repo.squads.join(", ")})`;
}

export function cfSettingsBlocks(summary: CfSettingsSummary): KnownBlock[] {
  const repoLine =
    summary.repos.length > 0 ? summary.repos.map(describeRepo).join(", ") : "none configured";

  return [
    { type: "section", text: { type: "mrkdwn", text: "*Code Freeze Report Configuration*" } },
    { type: "section", text: { type: "mrkdwn", text: `Repos: ${repoLine}` } },
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
        {
          type: "button",
          action_id: CF_REMOVE_CONFIG_ACTION,
          style: "danger",
          text: { type: "plain_text", text: "Remove config" },
          confirm: {
            title: { type: "plain_text", text: "Remove Code Freeze Report configuration" },
            text: {
              type: "mrkdwn",
              text: "Clear all repos, mentions, and the recurring schedule configured for this channel? Past rounds and their responses are kept.",
            },
            confirm: { type: "plain_text", text: "Remove" },
            deny: { type: "plain_text", text: "Cancel" },
          },
        },
      ],
    },
  ];
}

function diffRepoNames(before: readonly string[], after: readonly string[]): string[] {
  const added = after.filter((name) => !before.includes(name));
  const removed = before.filter((name) => !after.includes(name));
  const parts: string[] = [];
  if (added.length > 0) {
    parts.push(`added repo${added.length > 1 ? "s" : ""} ${added.map((n) => `\`${n}\``).join(", ")}`);
  }
  if (removed.length > 0) {
    parts.push(`removed repo${removed.length > 1 ? "s" : ""} ${removed.map((n) => `\`${n}\``).join(", ")}`);
  }
  return parts;
}

function mentionKey(target: CfMentionTarget): string {
  return `${target.kind}:${target.id}`;
}

function diffMentions(before: readonly CfMentionTarget[], after: readonly CfMentionTarget[]): string[] {
  if (before.length > 0 && after.length === 0) return ["cleared mentions"];

  const beforeKeys = new Set(before.map(mentionKey));
  const afterKeys = new Set(after.map(mentionKey));
  const added = after.filter((target) => !beforeKeys.has(mentionKey(target)));
  const removed = before.filter((target) => !afterKeys.has(mentionKey(target)));

  const parts: string[] = [];
  if (added.length > 0) parts.push(`added mention${added.length > 1 ? "s" : ""} ${added.map(mentionText).join(" ")}`);
  if (removed.length > 0) parts.push(`removed mention${removed.length > 1 ? "s" : ""} ${removed.map(mentionText).join(" ")}`);
  return parts;
}

function diffSchedule(before: CfSchedule | undefined, after: CfSchedule | undefined): string[] {
  if (!before && after) return [`set the recurring schedule to every ${formatDays(after.days)} at ${after.at}`];
  if (before && !after) return ["cleared the recurring schedule"];
  if (before && after && (before.at !== after.at || before.days !== after.days)) {
    return [`changed the recurring schedule to every ${formatDays(after.days)} at ${after.at}`];
  }
  return [];
}

/** A short plain-text line for the whole channel — no blocks, no buttons. The
 *  full interactive panel goes back to the editor alone, ephemerally. */
export function describeCfSettingsChange(
  editorUserId: string,
  before: CfSettingsSummary,
  after: CfSettingsSummary,
): string | undefined {
  const changes = [
    ...diffRepoNames(before.repos.map((repo) => repo.name), after.repos.map((repo) => repo.name)),
    ...diffMentions(before.mentions, after.mentions),
    ...diffSchedule(before.schedule, after.schedule),
  ];

  if (changes.length === 0) return undefined;
  return `${mention(editorUserId)} updated the Code Freeze Report configuration: ${changes.join("; ")}.`;
}
