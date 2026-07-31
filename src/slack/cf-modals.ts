import type { ViewStateValue } from "@slack/bolt";
import type { View } from "@slack/web-api";
import type { CfMentionTarget, CfSchedule } from "../domain/cf.js";
import { DAY_NAMES, daysToSelection } from "../domain/days.js";
import { dayOption } from "./modals.js";

export const CF_SETTINGS_FORM = "cf_settings_form";

/** A view submission carries no channel of its own, so it rides through here. */
export interface CfSettingsSource {
  channelId: string;
}

export interface CfSettingsData {
  repoNames: readonly string[];
  schedule?: CfSchedule | undefined;
  mentions: readonly CfMentionTarget[];
}

export function cfSettingsModal(data: CfSettingsData, source: CfSettingsSource): View {
  const selectedDays = data.schedule ? daysToSelection(data.schedule.days) : [];
  const mentionUserIds = data.mentions
    .filter((target) => target.kind === "user")
    .map((target) => target.id);
  const mentionGroupHandles = data.mentions
    .filter((target) => target.kind === "usergroup")
    .map((target) => target.handle ?? target.id);

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
        hint: { type: "plain_text", text: "One repo per line. Replaces the current list." },
        element: {
          type: "plain_text_input",
          action_id: "value",
          multiline: true,
          initial_value: data.repoNames.join("\n"),
        },
      },
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
        block_id: "mentionGroups",
        optional: true,
        label: { type: "plain_text", text: "Mention groups" },
        hint: {
          type: "plain_text",
          text: "User group handles to @-mention, one per line, e.g. esls. Leave empty for none.",
        },
        element: {
          type: "plain_text_input",
          action_id: "value",
          multiline: true,
          placeholder: { type: "plain_text", text: "esls" },
          ...(mentionGroupHandles.length > 0
            ? { initial_value: mentionGroupHandles.join("\n") }
            : {}),
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
  dayNames: string[];
  at: string;
  mentionUserIds: string[];
  mentionGroupHandles: string[];
}

export function readCfSettings(values: Values): CfSettingsFields {
  const reposRaw = values.repos?.value?.value ?? "";
  const repoNames = reposRaw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const dayNames = (values.days?.value?.selected_options ?? []).map((option) => option.value);
  const at = (values.at?.value?.value ?? "").trim();
  const mentionUserIds = values.mentionUsers?.value?.selected_users ?? [];
  const mentionGroupsRaw = values.mentionGroups?.value?.value ?? "";
  const mentionGroupHandles = mentionGroupsRaw
    .split("\n")
    .map((line) => line.trim().replace(/^@/, ""))
    .filter(Boolean);

  return { repoNames, dayNames, at, mentionUserIds, mentionGroupHandles };
}
