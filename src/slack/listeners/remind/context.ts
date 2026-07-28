import { fail, ok, type Parsed } from "../../../domain/result.js";
import type { Reminder } from "../../../domain/types.js";
import { getReminder } from "../../../store/reminders.js";
import type { Args } from "../../args.js";
import type { PendingAction } from "../../pending.js";

export interface CommandContext {
  channelId: string;
  userId: string;
  respond: (text: string) => Promise<unknown>;
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

export function readCode(args: Args): Parsed<string> {
  if (args.positionals.length > 1) {
    const extra = args.positionals.slice(1).join(" ");
    return fail(`unexpected \`${extra}\` — quote the message with \`"…"\``);
  }

  const code = args.positionals[0];
  if (!code) return fail("a code is required, like `standup`");
  return ok(code);
}
