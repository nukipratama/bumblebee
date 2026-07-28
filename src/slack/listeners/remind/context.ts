import type { KnownBlock } from "@slack/web-api";
import { fail, ok, type Parsed } from "../../../domain/result.js";
import type { Reminder } from "../../../domain/types.js";
import { getReminder } from "../../../store/reminders.js";
import type { PendingAction } from "../../pending.js";

export interface CommandContext {
  channelId: string;
  userId: string;
  /** `text` is the notification fallback whenever blocks are supplied. */
  respond: (text: string, blocks?: KnownBlock[]) => Promise<unknown>;
  ask: (summary: string, action: PendingAction) => Promise<void>;
}

/** Responds with the error and returns undefined, so callers can `if (x === undefined) return`. */
export async function unwrap<T>(ctx: CommandContext, parsed: Parsed<T>): Promise<T | undefined> {
  if (parsed.ok) return parsed.value;
  await ctx.respond(parsed.error);
  return undefined;
}

export function requireReminder(channelId: string, code: string): Parsed<Reminder> {
  const reminder = getReminder(channelId, code);
  return reminder ? ok(reminder) : fail(`no reminder \`${code}\` in this channel`);
}

export function readCode(rest: string): Parsed<string> {
  const [code, ...extra] = rest.trim().split(/\s+/).filter(Boolean);

  if (!code) return fail("a code is required, like `standup`");
  if (extra.length > 0) return fail(`unexpected \`${extra.join(" ")}\` — this takes just a code`);
  return ok(code);
}
