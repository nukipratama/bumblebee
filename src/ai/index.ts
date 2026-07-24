import { AzureOpenAI } from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { config } from "../config.js";

const client = new AzureOpenAI({
  endpoint: config.ai.endpoint,
  apiKey: config.ai.apiKey,
  apiVersion: config.ai.apiVersion,
  deployment: config.ai.deployment,
});

const SYSTEM_PROMPT = `You are Bumblebee, a friendly, concise Slack assistant for the LIMO engineering team.
Answer clearly and briefly. Use Slack-flavored markdown when helpful. If you don't know something, say so honestly.`;

/**
 * Send a conversation to Azure OpenAI and return the assistant's reply text.
 * `messages` should already be in chronological order (oldest first).
 */
export async function generateReply(
  messages: ChatCompletionMessageParam[],
): Promise<string> {
  const completion = await client.chat.completions.create({
    model: config.ai.deployment,
    messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
  });

  // The model emits standard Markdown, which we send to Slack via `markdown_text`
  // (Slack renders it natively — no mrkdwn conversion needed).
  return (
    completion.choices[0]?.message?.content?.trim() ??
    "🐝 ...I'm drawing a blank. Try asking again?"
  );
}
