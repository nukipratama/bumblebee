import { localParts } from "../../../domain/clock.js";
import { getHoliday, listHolidays } from "../../../store/reminders.js";
import { parseDate } from "../../args.js";
import { unwrap, type CommandContext } from "./context.js";

export const HOLIDAYS_ARE_SHARED =
  "_Holidays are shared — they skip reminders in every channel._";

async function handleHolidayList(ctx: CommandContext): Promise<void> {
  const holidays = listHolidays();
  const lines = holidays.map(
    (holiday) =>
      `• \`${holiday.date}\` — added by <@${holiday.addedBy}> in <#${holiday.addedInChannel}>`,
  );
  const body = holidays.length === 0 ? "No holidays recorded." : ["*Holidays*", ...lines].join("\n");
  await ctx.respond(`${body}\n\n${HOLIDAYS_ARE_SHARED}`);
}

async function handleHolidayAdd(ctx: CommandContext, date: string): Promise<void> {
  const existing = getHoliday(date);
  if (existing) {
    await ctx.respond(
      `\`${date}\` is already a holiday — added by <@${existing.addedBy}> in <#${existing.addedInChannel}>`,
    );
    return;
  }
  if (date < localParts(new Date()).date) {
    await ctx.respond(`\`${date}\` is in the past, so it can't skip anything`);
    return;
  }

  await ctx.ask(`Add holiday \`${date}\`?\n${HOLIDAYS_ARE_SHARED}`, { kind: "holidayAdd", date });
}

async function handleHolidayRemove(ctx: CommandContext, date: string): Promise<void> {
  if (!getHoliday(date)) {
    await ctx.respond(`\`${date}\` is not a holiday`);
    return;
  }

  await ctx.ask(`Remove holiday \`${date}\`?\n${HOLIDAYS_ARE_SHARED}`, {
    kind: "holidayRemove",
    date,
  });
}

export async function handleHoliday(ctx: CommandContext, rest: string): Promise<void> {
  const [action = "", value = ""] = rest.trim().split(/\s+/);

  if (action === "list") {
    await handleHolidayList(ctx);
    return;
  }
  if (action !== "add" && action !== "remove") {
    await ctx.respond("`holiday add <YYYY-MM-DD>`, `holiday list` or `holiday remove <YYYY-MM-DD>`");
    return;
  }

  const date = await unwrap(ctx, parseDate(value));
  if (date === undefined) return;

  if (action === "add") await handleHolidayAdd(ctx, date);
  else await handleHolidayRemove(ctx, date);
}
