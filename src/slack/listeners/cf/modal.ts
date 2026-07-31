import type { App, BlockAction, ButtonAction } from "@slack/bolt";
import type { CfMentionGroup } from "../../../domain/cf.js";
import {
  clearMentionGroup,
  clearSchedule,
  replaceRepos,
  setMentionGroup,
  setSchedule,
} from "../../../store/cf.js";
import { CF_EDIT_SETTINGS_ACTION, cfSettingsBlocks } from "../../cf-blocks.js";
import {
  CF_SETTINGS_FORM,
  cfSettingsModal,
  readCfSettings,
  type CfSettingsSource,
} from "../../cf-modals.js";
import { parseAt, daysFromSelection } from "../../modals.js";
import { buildCfSummary } from "./settings.js";

export function registerCfSettingsForm(app: App): void {
  app.action<BlockAction<ButtonAction>>(
    CF_EDIT_SETTINGS_ACTION,
    async ({ ack, body, client, logger }) => {
      await ack();
      try {
        const channelId = body.channel!.id;
        await client.views.open({
          trigger_id: body.trigger_id,
          view: cfSettingsModal(buildCfSummary(), { channelId }),
        });
      } catch (error) {
        logger.error("opening Code Freeze settings form failed", error);
      }
    },
  );

  app.view(CF_SETTINGS_FORM, async ({ ack, body, view, client, logger }) => {
    const { channelId } = JSON.parse(view.private_metadata) as CfSettingsSource;
    const fields = readCfSettings(view.state.values);

    let schedule: { at: string; days: string } | undefined;
    if (fields.dayNames.length > 0) {
      const at = parseAt(fields.at);
      if (!at.ok) {
        await ack({ response_action: "errors", errors: { at: at.error } });
        return;
      }
      // Only fails on an empty list, and dayNames is non-empty here.
      const days = daysFromSelection(fields.dayNames);
      if (!days.ok) {
        await ack({ response_action: "errors", errors: { days: days.error } });
        return;
      }
      schedule = { at: at.value, days: days.value };
    }

    let mentionGroup: CfMentionGroup | undefined;
    if (fields.mentionGroupHandle) {
      try {
        const { usergroups } = await client.usergroups.list({});
        const match = usergroups?.find(
          (group) => group.handle?.toLowerCase() === fields.mentionGroupHandle.toLowerCase(),
        );
        if (!match?.id || !match.handle) {
          await ack({
            response_action: "errors",
            errors: { mentionGroup: `No user group with handle @${fields.mentionGroupHandle}.` },
          });
          return;
        }
        mentionGroup = { id: match.id, handle: match.handle };
      } catch (error) {
        logger.error("looking up the Code Freeze mention group failed", error);
        await ack({
          response_action: "errors",
          errors: { mentionGroup: "Couldn't look up that group — check the logs." },
        });
        return;
      }
    }

    await ack();

    try {
      replaceRepos(fields.repoNames);
      if (schedule) setSchedule(channelId, schedule.at, schedule.days);
      else clearSchedule();
      if (mentionGroup) setMentionGroup(mentionGroup.id, mentionGroup.handle);
      else clearMentionGroup();

      await client.chat.postMessage({
        channel: channelId,
        text: "Code Freeze Report Configuration",
        blocks: cfSettingsBlocks(buildCfSummary()),
      });
    } catch (error) {
      logger.error("saving Code Freeze settings failed", error);
      await client.chat.postEphemeral({
        channel: channelId,
        user: body.user.id,
        text: "That didn't work. Check the logs.",
      });
    }
  });
}
