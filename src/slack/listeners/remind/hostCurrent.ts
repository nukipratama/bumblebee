import { localParts } from "../../../domain/clock.js";
import { hostChangeOpen } from "../../../domain/handover.js";
import type { Fire, Reminder } from "../../../domain/types.js";
import { getFireForDate, listHosts, listSkips } from "../../../store/reminders.js";
import { mention } from "../../text.js";

export type HostCurrentCheck = { fire: Fire } | { error: string };

/** Re-run at both prompt-build and apply time, since state can change in between. */
export function checkHostCurrent(reminder: Reminder, userId: string, now: number): HostCurrentCheck {
  const fire = getFireForDate(reminder.id, localParts(new Date(now)).date);
  if (!fire) return { error: `\`${reminder.code}\` hasn't fired yet today — nothing to set.` };

  if (fire.hostUserId === userId) {
    return { error: `${mention(userId)} is already hosting \`${reminder.code}\`.` };
  }

  if (!listHosts(reminder.id).some((member) => member.userId === userId)) {
    return { error: `${mention(userId)} is not on the rotation for \`${reminder.code}\`` };
  }

  if (listSkips(fire.id).some((skip) => skip.userId === userId)) {
    return { error: `${mention(userId)} already skipped \`${reminder.code}\` today — pick someone else` };
  }

  if (!hostChangeOpen(fire, reminder, now)) {
    return {
      error: `\`${reminder.code}\`'s meeting started over 30 minutes ago — the current host can no longer be changed.`,
    };
  }

  return { fire };
}
