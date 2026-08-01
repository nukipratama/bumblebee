import type { ViewStateValue } from "@slack/bolt";
import type { KnownBlock, View } from "@slack/web-api";
import {
  SQUADS,
  isSquad,
  type CfMentionTarget,
  type CfRepo,
  type CfSchedule,
  type CfStatus,
  type Squad,
} from "../domain/cf.js";
import { DAY_NAMES, daysToSelection } from "../domain/days.js";
import { escapeMrkdwn } from "./blocks.js";
import { dayOption } from "./modals.js";

export const CF_SETTINGS_FORM = "cf_settings_form";

export const CF_STATUS_MODAL_CANCEL_ACTION = "cf_status_modal_cancel";
export const CF_STATUS_MODAL_SET_ACTION = "cf_status_modal_set";
export const CF_STATUS_MODAL_SET_ACTION_PATTERN = new RegExp(`^${CF_STATUS_MODAL_SET_ACTION}_`);

function modalSetActionId(status: CfStatus): string {
  return `${CF_STATUS_MODAL_SET_ACTION}_${status}`;
}

/** Rides through `private_metadata` — repo/round context is re-resolved server-side, not stuffed in here. */
export interface CfStatusModalMetadata {
  channelId: string;
  messageTs: string;
  squad: Squad;
}

function cfStatusModalTitle(squad: Squad): { type: "plain_text"; text: string } {
  return { type: "plain_text", text: `Code Freeze — ${squad}` };
}

export function cfStatusModal(
  squad: Squad,
  data: { repoName: string; roundStartedAt?: string },
  meta: CfStatusModalMetadata,
): View {
  const dateLine = data.roundStartedAt ? `\nRound started ${data.roundStartedAt}` : "";
  return {
    type: "modal",
    private_metadata: JSON.stringify(meta),
    title: cfStatusModalTitle(squad),
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `${escapeMrkdwn(data.repoName)}${dateLine}` } },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: CF_STATUS_MODAL_CANCEL_ACTION,
            text: { type: "plain_text", text: "Cancel" },
          },
          {
            type: "button",
            action_id: modalSetActionId("no_mr"),
            style: "danger",
            text: { type: "plain_text", text: "No MR" },
            value: "no_mr",
          },
          {
            type: "button",
            action_id: modalSetActionId("all_merged"),
            style: "primary",
            text: { type: "plain_text", text: "All Merged" },
            value: "all_merged",
          },
        ],
      },
    ],
  };
}

/** Swapped in via `views.update` after Cancel/No MR/All Merged — a modal can't be force-closed from a block action. */
export function cfStatusResolvedModal(squad: Squad, message: string): View {
  return {
    type: "modal",
    title: cfStatusModalTitle(squad),
    blocks: [{ type: "section", text: { type: "mrkdwn", text: message } }],
  };
}

/** A view submission carries no channel of its own, so it rides through here. */
export interface CfSettingsSource {
  channelId: string;
}

export interface CfSettingsData {
  repos: readonly CfRepo[];
  schedule?: CfSchedule | undefined;
  mentions: readonly CfMentionTarget[];
}

export const MENTION_GROUPS_BLOCK_ID = "mentionGroups";
export const MENTION_GROUPS_ACTION_ID = "groups";

/** A `multi_external_select` option's value is one opaque string — the group id. */
export function mentionGroupOptionValue(groupId: string): string {
  return groupId;
}

const REPO_SQUADS_PREFIX = "repoSquads:";

export function repoSquadsBlockId(repoName: string): string {
  return `${REPO_SQUADS_PREFIX}${repoName}`;
}

const squadOption = (squad: Squad) => ({
  text: { type: "plain_text" as const, text: squad },
  value: squad,
});

/** Only rendered for a repo already saved — a repo just typed into the Repos
 *  box has no row here until it's saved once and the form is reopened. */
function repoSquadsBlock(repo: CfRepo): KnownBlock {
  return {
    type: "input",
    block_id: repoSquadsBlockId(repo.name),
    optional: true,
    label: { type: "plain_text", text: `Squads — ${repo.name}` },
    hint: { type: "plain_text", text: "Unchecked = all squads report on this repo." },
    element: {
      type: "checkboxes",
      action_id: "value",
      options: SQUADS.map(squadOption),
      initial_options: repo.squads.map(squadOption),
    },
  };
}

export function cfSettingsModal(data: CfSettingsData, source: CfSettingsSource): View {
  const selectedDays = data.schedule ? daysToSelection(data.schedule.days) : [];
  const mentionUserIds = data.mentions
    .filter((target) => target.kind === "user")
    .map((target) => target.id);
  const mentionGroupOptions = data.mentions
    .filter((target) => target.kind === "usergroup")
    .map((target) => ({
      text: { type: "plain_text" as const, text: target.handle ?? `Group ${target.id}` },
      value: mentionGroupOptionValue(target.id),
    }));

  return {
    type: "modal",
    callback_id: CF_SETTINGS_FORM,
    private_metadata: JSON.stringify(source),
    title: { type: "plain_text", text: "Code Freeze settings" },
    submit: { type: "plain_text", text: "Save" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "repos",
        label: { type: "plain_text", text: "Repos" },
        hint: {
          type: "plain_text",
          text: "One repo per line. Replaces the current list. Save, then reopen this form to set a new repo's squads.",
        },
        element: {
          type: "plain_text_input",
          action_id: "value",
          multiline: true,
          initial_value: data.repos.map((repo) => repo.name).join("\n"),
        },
      },
      ...data.repos.map(repoSquadsBlock),
      {
        type: "input",
        block_id: "mentionUsers",
        optional: true,
        label: { type: "plain_text", text: "Mention users" },
        hint: { type: "plain_text", text: "Individual people to @-mention on every post." },
        element: {
          type: "multi_users_select",
          action_id: "value",
          ...(mentionUserIds.length > 0 ? { initial_users: mentionUserIds } : {}),
        },
      },
      {
        type: "input",
        block_id: MENTION_GROUPS_BLOCK_ID,
        optional: true,
        label: { type: "plain_text", text: "Mention groups" },
        hint: { type: "plain_text", text: "User groups to @-mention on every post." },
        element: {
          type: "multi_external_select",
          action_id: MENTION_GROUPS_ACTION_ID,
          placeholder: { type: "plain_text", text: "Search user groups" },
          min_query_length: 0,
          ...(mentionGroupOptions.length > 0 ? { initial_options: mentionGroupOptions } : {}),
        },
      },
      {
        type: "input",
        block_id: "days",
        optional: true,
        label: { type: "plain_text", text: "Recurring schedule — days" },
        hint: {
          type: "plain_text",
          text: "Leave empty for no recurring schedule — Start now still works manually.",
        },
        element: {
          type: "checkboxes",
          action_id: "value",
          options: DAY_NAMES.map(dayOption),
          ...(selectedDays.length > 0 ? { initial_options: selectedDays.map(dayOption) } : {}),
        },
      },
      {
        type: "input",
        block_id: "at",
        optional: true,
        label: { type: "plain_text", text: "Recurring schedule — time" },
        hint: {
          type: "plain_text",
          text: "24-hour, Asia/Jakarta — e.g. 09:00. Required if days are picked.",
        },
        element: {
          type: "plain_text_input",
          action_id: "value",
          placeholder: { type: "plain_text", text: "09:00" },
          ...(data.schedule ? { initial_value: data.schedule.at } : {}),
        },
      },
    ],
  };
}

export type Values = Record<string, Record<string, ViewStateValue>>;

export interface CfSettingsFields {
  repoNames: string[];
  repoSquads: ReadonlyMap<string, readonly Squad[]>;
  dayNames: string[];
  at: string;
  mentions: CfMentionTarget[];
}

function readRepoSquads(values: Values): ReadonlyMap<string, readonly Squad[]> {
  const map = new Map<string, readonly Squad[]>();
  for (const [blockId, block] of Object.entries(values)) {
    if (!blockId.startsWith(REPO_SQUADS_PREFIX)) continue;
    const repoName = blockId.slice(REPO_SQUADS_PREFIX.length);
    const selected = (block.value?.selected_options ?? []).map((option) => option.value).filter(isSquad);
    map.set(repoName, selected);
  }
  return map;
}

export function readCfSettings(values: Values): CfSettingsFields {
  const reposRaw = values.repos?.value?.value ?? "";
  const repoNames = reposRaw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const repoSquads = readRepoSquads(values);
  const dayNames = (values.days?.value?.selected_options ?? []).map((option) => option.value);
  const at = (values.at?.value?.value ?? "").trim();
  const mentionUserIds = values.mentionUsers?.value?.selected_users ?? [];
  // The picker only ever offers real groups, so the selection is already fully
  // resolved — no server-side lookup needed, unlike the old typed-handle field.
  const mentionGroupSelections =
    values[MENTION_GROUPS_BLOCK_ID]?.[MENTION_GROUPS_ACTION_ID]?.selected_options ?? [];
  const mentions: CfMentionTarget[] = [
    ...mentionUserIds.map((id) => ({ kind: "user" as const, id })),
    ...mentionGroupSelections.map((option) => ({
      kind: "usergroup" as const,
      id: option.value,
      handle: option.text.text,
    })),
  ];

  return { repoNames, repoSquads, dayNames, at, mentions };
}
