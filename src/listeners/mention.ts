import type { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { generateReply } from "../ai/index.js";

const HISTORY_LIMIT = 20;

/** Remove Slack mention tokens like <@U123> from message text. */
function stripMentions(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, "").trim();
}

/**
 * Build the chat history for the AI. If the mention happened inside an existing
 * thread, fetch prior messages so the bot holds a conversation; otherwise just
 * use the single mention text.
 */
async function buildConversation(
  client: WebClient,
  channel: string,
  threadTs: string,
  mentionText: string,
  isInThread: boolean,
  botUserId: string | undefined,
): Promise<ChatCompletionMessageParam[]> {
  if (!isInThread) {
    return [{ role: "user", content: stripMentions(mentionText) }];
  }

  const replies = await client.conversations.replies({
    channel,
    ts: threadTs,
    limit: HISTORY_LIMIT,
  });

  const messages = (replies.messages ?? [])
    .map((m): ChatCompletionMessageParam | null => {
      const content = stripMentions(m.text ?? "");
      if (!content) return null;
      const isBot = Boolean(botUserId && m.user === botUserId) || Boolean(m.bot_id);
      return { role: isBot ? "assistant" : "user", content };
    })
    .filter((m): m is ChatCompletionMessageParam => m !== null);

  return messages.length > 0
    ? messages
    : [{ role: "user", content: stripMentions(mentionText) }];
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
        markdown_text: reply,
        thread_ts: threadTs,
      });
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
