import type { App, BlockAction, ButtonAction, DatepickerAction } from "@slack/bolt";
import { localParts } from "../../../domain/clock.js";
import { getHoliday, listHolidays } from "../../../store/reminders.js";
import {
  HOLIDAY_ADD_ACTION,
  HOLIDAY_REMOVE_ACTION,
  confirmBlocks,
  holidayListBlocks,
} from "../../blocks.js";
import { put } from "../../pending.js";
import type { PendingAction } from "../../pending.js";
import type { CommandContext } from "./context.js";

export const HOLIDAYS_ARE_SHARED =
  "_Holidays are shared — they skip reminders in every channel._";

export async function handleHolidayList(ctx: CommandContext): Promise<void> {
  await ctx.respond("Holidays", holidayListBlocks(listHolidays(), HOLIDAYS_ARE_SHARED));
}

type Decision = { summary: string; action: PendingAction } | { error: string };

function decideAdd(date: string): Decision {
  const existing = getHoliday(date);
  if (existing) {
    return {
      error: `\`${date}\` is already a holiday — added by <@${existing.addedBy}> in <#${existing.addedInChannel}>`,
    };
  }
  if (date < localParts(new Date()).date) {
    return { error: `\`${date}\` is in the past, so it can't skip anything` };
  }

  return {
    summary: `Add holiday \`${date}\`?\n${HOLIDAYS_ARE_SHARED}`,
    action: { kind: "holidayAdd", date },
  };
}

function decideRemove(date: string): Decision {
  if (!getHoliday(date)) return { error: `\`${date}\` is not a holiday` };

  return {
    summary: `Remove holiday \`${date}\`?\n${HOLIDAYS_ARE_SHARED}`,
    action: { kind: "holidayRemove", date },
  };
}

export function registerHolidayActions(app: App): void {
  const register = <T extends ButtonAction | DatepickerAction>(
    actionId: string,
    dateOf: (action: T) => string | undefined,
    decide: (date: string) => Decision,
  ) =>
    app.action<BlockAction<T>>(actionId, async ({ ack, body, respond, logger }) => {
      await ack();
      try {
        const date = dateOf(body.actions[0]!);
        if (!date) return;

        const decision = decide(date);
        if ("error" in decision) {
          await respond({ text: decision.error });
          return;
        }

        const pendingId = put({
          action: decision.action,
          userId: body.user.id,
          channelId: body.channel!.id,
        });
        await respond({
          text: decision.summary,
          blocks: confirmBlocks(decision.summary, pendingId),
        });
      } catch (error) {
        logger.error("holiday action failed", error);
      }
    });

  register<DatepickerAction>(
    HOLIDAY_ADD_ACTION,
    (action) => action.selected_date ?? undefined,
    decideAdd,
  );
  register<ButtonAction>(HOLIDAY_REMOVE_ACTION, (action) => action.value, decideRemove);
}
