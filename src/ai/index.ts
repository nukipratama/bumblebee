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

const BLANK_REPLY = "🐝 ...I'm drawing a blank. Try asking again?";

export interface AiReply {
  text: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/** `chronological` runs oldest first, as the Chat Completions API expects. */
export async function generateReply(
  chronological: ChatCompletionMessageParam[],
): Promise<AiReply> {
  const completion = await client.chat.completions.create({
    model: config.ai.deployment,
    messages: [{ role: "system", content: SYSTEM_PROMPT }, ...chronological],
  });

  return {
    text: completion.choices[0]?.message?.content?.trim() ?? BLANK_REPLY,
    usage: {
      promptTokens: completion.usage?.prompt_tokens ?? 0,
      completionTokens: completion.usage?.completion_tokens ?? 0,
      totalTokens: completion.usage?.total_tokens ?? 0,
    },
  };
}
