import { AzureOpenAI } from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { config } from "../config.js";

const client = new AzureOpenAI({
  endpoint: config.ai.endpoint,
  apiKey: config.ai.apiKey,
  apiVersion: config.ai.apiVersion,
  deployment: config.ai.deployment,
});

const SYSTEM_PROMPT = `You are Bumblebee, a friendly, concise Slack assistant for the LIMO team.
Answer clearly and briefly. Use Slack-flavored markdown when helpful. If you don't know something, say so honestly.`;

export interface AiReply {
  text: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/**
 * Send a conversation to Azure OpenAI and return the assistant's reply text
 * plus token usage. `messages` should already be in chronological order
 * (oldest first).
 */
export async function generateReply(
  messages: ChatCompletionMessageParam[],
): Promise<AiReply> {
  const completion = await client.chat.completions.create({
    model: config.ai.deployment,
    messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
  });

  // The model emits standard Markdown, which we send to Slack via `markdown_text`
  // (Slack renders it natively — no mrkdwn conversion needed).
  const text =
    completion.choices[0]?.message?.content?.trim() ??
    "🐝 ...I'm drawing a blank. Try asking again?";

  return {
    text,
    usage: {
      promptTokens: completion.usage?.prompt_tokens ?? 0,
      completionTokens: completion.usage?.completion_tokens ?? 0,
      totalTokens: completion.usage?.total_tokens ?? 0,
    },
  };
}
