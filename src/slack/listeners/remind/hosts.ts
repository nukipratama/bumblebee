import { hasHosted, pendingLap } from "../../../domain/rotation.js";
import type { Host, Reminder } from "../../../domain/types.js";
import { lastHostedOn, listHosts } from "../../../store/reminders.js";
import { parseUserMentions } from "../../args.js";
import { formatRosterDiff, mention } from "../../text.js";
import { requireReminder, unwrap, type CommandContext } from "./context.js";

const HOST_USAGE =
  "`host set <code> @a @b`, `host clear <code>`, `host skip <code>` or `host next <code> @who`";

const NO_ROTATION = (code: string): string =>
  `\`${code}\` has no rotation — set one with \`host set\``;

function sameRoster(roster: readonly Host[], userIds: readonly string[]): boolean {
  return (
    roster.length === userIds.length && roster.every((member) => userIds.includes(member.userId))
  );
}

async function handleHostSet(
  ctx: CommandContext,
  reminder: Reminder,
  people: string[],
): Promise<void> {
  const userIds = await unwrap(ctx, parseUserMentions(people));
  if (userIds === undefined) return;

  const roster = listHosts(reminder.id);
  if (sameRoster(roster, userIds)) {
    await ctx.respond(`those are already the ${userIds.length} people on \`${reminder.code}\``);
    return;
  }

  const upNext = pendingLap(roster)[0];
  const keepsLead = upNext !== undefined && userIds.includes(upNext);

  await ctx.ask(
    [
      `Set the rotation for \`${reminder.code}\`?`,
      ...formatRosterDiff(roster, userIds),
      keepsLead
        ? `${mention(upNext)} stays up next. The order for the rest is drawn when you approve.`
        : "The order is drawn when you approve.",
    ].join("\n"),
    { kind: "hostSet", code: reminder.code, userIds },
  );
}

async function handleHostClear(ctx: CommandContext, reminder: Reminder): Promise<void> {
  if (listHosts(reminder.id).length === 0) {
    await ctx.respond(NO_ROTATION(reminder.code));
    return;
  }

  await ctx.ask(
    `Remove the rotation from \`${reminder.code}\`? It will post with no host line, and the lap is lost.`,
    { kind: "hostClear", code: reminder.code },
  );
}

async function handleHostSkip(ctx: CommandContext, reminder: Reminder): Promise<void> {
  const roster = listHosts(reminder.id);
  if (roster.length === 0) {
    await ctx.respond(NO_ROTATION(reminder.code));
    return;
  }
  if (roster.length === 1) {
    await ctx.respond(`there's only one person on \`${reminder.code}\` — nothing to skip to`);
    return;
  }

  const lap = pendingLap(roster);
  const upNext = lap[0]!;
  const after =
    lap.length > 1
      ? [
          `${mention(lap[1]!)} would be up next.`,
          "They keep their turn — they move to the back of this lap.",
        ]
      : [
          "They were last in this lap, so it rolls over and a fresh order is drawn.",
          "They keep their turn — everyone is pending again in the new lap.",
        ];

  await ctx.ask([`Skip ${mention(upNext)} on \`${reminder.code}\`?`, ...after].join("\n"), {
    kind: "hostSkip",
    code: reminder.code,
  });
}

async function handleHostNext(
  ctx: CommandContext,
  reminder: Reminder,
  people: string[],
): Promise<void> {
  const userIds = await unwrap(ctx, parseUserMentions(people));
  if (userIds === undefined) return;
  if (userIds.length > 1) {
    await ctx.respond("`host next` takes one person");
    return;
  }

  const userId = userIds[0]!;
  const member = listHosts(reminder.id).find((entry) => entry.userId === userId);
  if (!member) {
    await ctx.respond(`${mention(userId)} is not on the rotation for \`${reminder.code}\``);
    return;
  }

  const hostedOn = lastHostedOn(reminder.id).get(userId) ?? "earlier";
  const lines = [`Put ${mention(userId)} up next on \`${reminder.code}\`?`];
  if (hasHosted(member)) {
    lines.push(`They already hosted this lap on ${hostedOn}, so they'll host again.`);
  }

  await ctx.ask(lines.join("\n"), { kind: "hostNext", code: reminder.code, userId });
}

export async function handleHost(ctx: CommandContext, rest: string): Promise<void> {
  const [action = "", code = "", ...people] = rest.trim().split(/\s+/).filter(Boolean);

  if (!["set", "clear", "skip", "next"].includes(action) || code === "") {
    await ctx.respond(HOST_USAGE);
    return;
  }

  const reminder = await unwrap(ctx, requireReminder(ctx.channelId, code));
  if (reminder === undefined) return;

  if (action === "set") return handleHostSet(ctx, reminder, people);
  if (action === "clear") return handleHostClear(ctx, reminder);
  if (action === "skip") return handleHostSkip(ctx, reminder);
  return handleHostNext(ctx, reminder, people);
}
