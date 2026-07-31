import type { App, BlockAction, ButtonAction } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { statusLabel, type CfStatus, type Squad } from "../../../domain/cf.js";
import { getMessageByTs, getRepoById, getResponses, listMentions, upsertResponse } from "../../../store/cf.js";
import {
  CF_STATUS_ACTION_PATTERN,
  cfFallbackText,
  cfRepoBlocks,
  type CfButtonValue,
} from "../../cf-blocks.js";

const MESSAGE_GONE =
  "I can't find the Code Freeze round this belongs to — it may be from an older round.";

async function repost(
  client: WebClient,
  channelId: string,
  messageTs: string,
  repoId: number,
  messageId: number,
): Promise<void> {
  const repo = getRepoById(repoId) ?? { name: "unknown repo" };
  const responses = getResponses(messageId);
  const mentions = listMentions(channelId);

  await client.chat.update({
    channel: channelId,
    ts: messageTs,
    blocks: cfRepoBlocks(repo, responses, mentions),
    text: cfFallbackText(repo),
  });
}

export function registerCfStatus(app: App): void {
  app.action<BlockAction<ButtonAction>>(CF_STATUS_ACTION_PATTERN, async ({ ack, body, client, logger }) => {
    await ack();

    const messageTs = body.message?.ts;
    const channelId = body.channel?.id;
    const clicker = body.user.id;
    const raw = body.actions[0]?.value;
    if (!messageTs || !channelId || !raw) return;

    const { squad, status }: CfButtonValue = JSON.parse(raw) as { squad: Squad; status: CfStatus };

    const message = getMessageByTs(messageTs);
    if (!message) {
      await client.chat.postEphemeral({ channel: channelId, user: clicker, text: MESSAGE_GONE });
      return;
    }

    upsertResponse(message.id, squad, status, clicker);

    try {
      await repost(client, channelId, messageTs, message.repoId, message.id);
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
  });
}
