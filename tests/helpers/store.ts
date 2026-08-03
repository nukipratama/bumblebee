import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogLevel, type Logger } from "@slack/bolt";
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
    leadMinutes: 0,
    preMessage: null,
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

export interface UpdatedMessage {
  channel: string;
  ts: string;
  blocks?: unknown[];
  text?: string;
}

export interface FakeClient {
  client: WebClient;
  posted: PostedMessage[];
  updated: UpdatedMessage[];
}

/** A stand-in for the parts of WebClient the reminder path touches. */
export function fakeClient(
  postMessage: (args: PostedMessage) => Promise<{ ts?: string }> = async () => ({ ts: "1.1" }),
  chatUpdate: (args: UpdatedMessage) => Promise<unknown> = async () => ({}),
): FakeClient {
  const posted: PostedMessage[] = [];
  const updated: UpdatedMessage[] = [];
  const client = {
    chat: {
      postMessage: async (args: PostedMessage) => {
        posted.push(args);
        return postMessage(args);
      },
      update: async (args: UpdatedMessage) => {
        updated.push(args);
        return chatUpdate(args);
      },
    },
  } as unknown as WebClient;

  return { client, posted, updated };
}

/** A stand-in Logger — does nothing instead of writing to stdout/stderr. */
export function fakeLogger(): Logger {
  const noop = (): void => undefined;
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    setLevel: noop,
    getLevel: () => LogLevel.ERROR,
    setName: noop,
  };
}
