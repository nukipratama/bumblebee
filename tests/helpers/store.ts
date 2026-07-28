import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebClient } from "@slack/web-api";
import type { NewReminder } from "../../src/domain/types.js";

/**
 * `config.ts` fails fast on missing env and `store/database.ts` opens `DB_PATH`
 * at import time, so both must be set before anything under `src/store` loads —
 * which is why the modules under test are imported dynamically, after this runs.
 * Node's test runner gives each file its own process, so each gets its own DB.
 */
export function useTempDatabase(): void {
  process.env.SLACK_BOT_TOKEN ??= "xoxb-test";
  process.env.SLACK_APP_TOKEN ??= "xapp-test";
  process.env.AZURE_OPENAI_ENDPOINT ??= "https://azure.invalid";
  process.env.AZURE_OPENAI_API_KEY ??= "test-key";
  process.env.AZURE_OPENAI_DEPLOYMENT ??= "test-deployment";
  process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "bumblebee-test-")), "bumblebee.db");
}

export function newReminder(overrides: Partial<NewReminder> = {}): NewReminder {
  return {
    channelId: "C1",
    code: "standup",
    at: "09:00",
    days: "*",
    message: "Standup time!",
    bodyFormat: "markdown",
    everyNWeeks: 1,
    createdBy: "U_CREATOR",
    ...overrides,
  };
}

export interface PostedMessage {
  channel: string;
  blocks?: unknown[];
  text?: string;
  unfurl_links?: boolean;
  unfurl_media?: boolean;
}

export interface FakeClient {
  client: WebClient;
  posted: PostedMessage[];
}

/** A stand-in for the parts of WebClient the reminder path touches. */
export function fakeClient(
  postMessage: (args: PostedMessage) => Promise<{ ts?: string }> = async () => ({ ts: "1.1" }),
): FakeClient {
  const posted: PostedMessage[] = [];
  const client = {
    chat: {
      postMessage: async (args: PostedMessage) => {
        posted.push(args);
        return postMessage(args);
      },
    },
  } as unknown as WebClient;

  return { client, posted };
}
