import type { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { generateReply } from "../../ai/index.js";
import { config } from "../../config.js";
import { recordAiUsage } from "../../store/ai-usage.js";

const HISTORY_LIMIT = 20;

function stripMentions(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, "").trim();
}

async function buildConversation(
  client: WebClient,
  channel: string,
  threadTs: string,
  mentionText: string,
  isInThread: boolean,
  botUserId: string | undefined,
): Promise<ChatCompletionMessageParam[]> {
  const singleTurn: ChatCompletionMessageParam[] = [
    { role: "user", content: stripMentions(mentionText) },
  ];
  if (!isInThread) return singleTurn;

  const replies = await client.conversations.replies({
    channel,
    ts: threadTs,
    limit: HISTORY_LIMIT,
  });

  const messages = (replies.messages ?? [])
    .map((message): ChatCompletionMessageParam | null => {
      const content = stripMentions(message.text ?? "");
      if (!content) return null;
      const isBot = Boolean(botUserId && message.user === botUserId) || Boolean(message.bot_id);
      return { role: isBot ? "assistant" : "user", content };
    })
    .filter((message): message is ChatCompletionMessageParam => message !== null);

  return messages.length > 0 ? messages : singleTurn;
}

export function registerMention(app: App): void {
  app.event("app_mention", async ({ event, client, context, logger }) => {
    const threadTs = event.thread_ts ?? event.ts;
    try {
      const conversation = await buildConversation(
        client,
        event.channel,
        threadTs,
        event.text ?? "",
        Boolean(event.thread_ts),
        context.botUserId,
      );
      const reply = await generateReply(conversation);

      // `markdown_text` lets Slack render the model's standard Markdown natively.
      await client.chat.postMessage({
        channel: event.channel,
        markdown_text: reply.text,
        thread_ts: threadTs,
      });

      try {
        recordAiUsage({
          slackUserId: event.user,
          channelId: event.channel,
          model: config.ai.deployment,
          ...reply.usage,
        });
      } catch (error) {
        logger.error("Failed to record AI usage", error);
      }
    } catch (error) {
      logger.error("AI reply failed", error);
      await client.chat.postMessage({
        channel: event.channel,
        text: "🐝 Sorry, my circuits jammed — give me a moment and try again.",
        thread_ts: threadTs,
      });
    }
  });
}
