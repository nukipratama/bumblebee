import type { App } from "@slack/bolt";
import { MENTION_GROUPS_ACTION_ID, mentionGroupOptionValue } from "../../cf-modals.js";

/** Slack caps a suggestion response at 100 options. */
const MAX_OPTIONS = 100;

export function registerCfMentionOptions(app: App): void {
  app.options(MENTION_GROUPS_ACTION_ID, async ({ ack, payload }) => {
    const query = payload.value.trim().toLowerCase();

    const { usergroups } = await app.client.usergroups.list({});
    const options = (usergroups ?? [])
      .filter((group) => query.length === 0 || `${group.name} ${group.handle}`.toLowerCase().includes(query))
      .slice(0, MAX_OPTIONS)
      .map((group) => ({
        text: { type: "plain_text" as const, text: `${group.name} (@${group.handle})` },
        value: mentionGroupOptionValue(group.id!),
      }));

    await ack({ options });
  });
}
