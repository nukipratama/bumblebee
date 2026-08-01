import type { App, BlockAction, ButtonAction } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { isCfStatus, isSquad, statusLabel, type CfStatus, type Squad } from "../../../domain/cf.js";
import {
  getMessageByTs,
  getRepoById,
  getResponses,
  getRoundStartedAt,
  listMentions,
  upsertResponse,
  type CfMessageRef,
} from "../../../store/cf.js";
import { CF_STATUS_OPEN_ACTION_PATTERN, cfFallbackText, cfRepoBlocks } from "../../cf-blocks.js";
import {
  CF_STATUS_MODAL_CANCEL_ACTION,
  CF_STATUS_MODAL_SET_ACTION_PATTERN,
  cfStatusModal,
  cfStatusResolvedModal,
  type CfStatusModalMetadata,
} from "../../cf-modals.js";
import { formatDate } from "../../text.js";

const MESSAGE_GONE =
  "I can't find the Code Freeze round this belongs to — it may be from an older round.";
const NO_CHANGES_TEXT = "No changes made. You can close this window.";

function recordedText(squad: Squad, status: CfStatus): string {
  return `✅ Set *${squad}* → *${statusLabel(status)}*. You can close this window.`;
}

function getRepoName(repoId: number): string {
  return getRepoById(repoId)?.name ?? "unknown repo";
}

async function repost(
  client: WebClient,
  channelId: string,
  messageTs: string,
  message: CfMessageRef,
): Promise<void> {
  const repo = { name: getRepoName(message.repoId), squads: message.squads };
  const responses = getResponses(message.id);
  const mentions = listMentions(channelId);

  await client.chat.update({
    channel: channelId,
    ts: messageTs,
    blocks: cfRepoBlocks(repo, responses, mentions),
    text: cfFallbackText(repo),
  });
}

export function registerCfStatus(app: App): void {
  app.action<BlockAction<ButtonAction>>(CF_STATUS_OPEN_ACTION_PATTERN, async ({ ack, body, client, logger }) => {
    await ack();

    const messageTs = body.message?.ts;
    const channelId = body.channel?.id;
    const clicker = body.user.id;
    const raw = body.actions[0]?.value;
    if (!messageTs || !channelId || !raw || !isSquad(raw)) return;
    const squad = raw;

    const message = getMessageByTs(messageTs);
    if (!message) {
      await client.chat.postEphemeral({ channel: channelId, user: clicker, text: MESSAGE_GONE });
      return;
    }

    const repoName = getRepoName(message.repoId);
    const startedAt = getRoundStartedAt(message.roundId);
    const meta: CfStatusModalMetadata = { channelId, messageTs, squad };

    try {
      await client.views.open({
        trigger_id: body.trigger_id,
        view: cfStatusModal(
          squad,
          { repoName, roundStartedAt: startedAt ? formatDate(startedAt) : undefined },
          meta,
        ),
      });
    } catch (error) {
      logger.error("opening Code Freeze status form failed", error);
    }
  });

  app.action<BlockAction<ButtonAction>>(CF_STATUS_MODAL_CANCEL_ACTION, async ({ ack, body, client, logger }) => {
    await ack();
    if (!body.view) return;

    const { squad } = JSON.parse(body.view.private_metadata) as CfStatusModalMetadata;

    try {
      await client.views.update({
        view_id: body.view.id,
        view: cfStatusResolvedModal(squad, NO_CHANGES_TEXT),
      });
    } catch (error) {
      logger.error("closing the Code Freeze status form failed", error);
    }
  });

  app.action<BlockAction<ButtonAction>>(
    CF_STATUS_MODAL_SET_ACTION_PATTERN,
    async ({ ack, body, client, logger }) => {
      await ack();
      if (!body.view) return;

      const { channelId, messageTs, squad } = JSON.parse(body.view.private_metadata) as CfStatusModalMetadata;
      const clicker = body.user.id;
      const raw = body.actions[0]?.value;
      if (!raw || !isCfStatus(raw)) return;
      const status = raw;

      const message = getMessageByTs(messageTs);
      if (!message) {
        try {
          await client.views.update({
            view_id: body.view.id,
            view: cfStatusResolvedModal(squad, MESSAGE_GONE),
          });
        } catch (error) {
          logger.error("closing the Code Freeze status form failed", error);
        }
        return;
      }

      upsertResponse(message.id, squad, status, clicker);

      try {
        await repost(client, channelId, messageTs, message);
      } catch (error) {
        logger.error("updating the Code Freeze post failed", error);
      }

      try {
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: messageTs,
          text: `🔔 <@${clicker}> set *${squad}* → *${statusLabel(status)}*`,
        });
      } catch (error) {
        logger.error("posting the Code Freeze thread reply failed", error);
      }

      try {
        await client.views.update({
          view_id: body.view.id,
          view: cfStatusResolvedModal(squad, recordedText(squad, status)),
        });
      } catch (error) {
        logger.error("closing the Code Freeze status form failed", error);
      }
    },
  );
}
