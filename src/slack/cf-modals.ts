import type { ViewStateValue } from "@slack/bolt";
import type { View } from "@slack/web-api";
import type { CfMentionGroup, CfSchedule } from "../domain/cf.js";
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
  mentionGroup?: CfMentionGroup | undefined;
}

export function cfSettingsModal(data: CfSettingsData, source: CfSettingsSource): View {
  const selectedDays = data.schedule ? daysToSelection(data.schedule.days) : [];

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
        block_id: "mentionGroup",
        optional: true,
        label: { type: "plain_text", text: "Mention group" },
        hint: {
          type: "plain_text",
          text: "A user group handle to @-mention on every post, e.g. esls. Leave empty for none.",
        },
        element: {
          type: "plain_text_input",
          action_id: "value",
          placeholder: { type: "plain_text", text: "esls" },
          ...(data.mentionGroup ? { initial_value: data.mentionGroup.handle } : {}),
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
  mentionGroupHandle: string;
}

export function readCfSettings(values: Values): CfSettingsFields {
  const reposRaw = values.repos?.value?.value ?? "";
  const repoNames = reposRaw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const dayNames = (values.days?.value?.selected_options ?? []).map((option) => option.value);
  const at = (values.at?.value?.value ?? "").trim();
  const mentionGroupHandle = (values.mentionGroup?.value?.value ?? "").trim().replace(/^@/, "");

  return { repoNames, dayNames, at, mentionGroupHandle };
}
