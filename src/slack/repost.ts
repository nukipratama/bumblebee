import type { Logger } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import type { Fire, Reminder } from "../domain/types.js";
import { listHosts, listReports, listSkips } from "../store/reminders.js";
import { fallbackText, type PostBody, reminderBlocks, reminderBody, type ReminderPost } from "./blocks.js";
import { resolveDisplayNames } from "./names.js";

export function postNames(
  client: WebClient,
  logger: Logger,
  { skips, reporters }: Pick<ReminderPost, "skips" | "reporters">,
): Promise<Map<string, string>> {
  const userIds = new Set([...skips, ...reporters].map(({ userId }) => userId));
  return resolveDisplayNames(client, logger, [...userIds]);
}

/** Both posts carry the buttons and the same lists, so both are rewritten. */
export function postsOf(fire: Fire, reminder: Reminder): { ts: string; which: PostBody }[] {
  const posts: { ts: string; which: PostBody }[] = [];
  if (fire.messageTs) {
    posts.push({ ts: fire.messageTs, which: reminder.leadMinutes > 0 ? "heads-up" : "meeting" });
  }
  if (fire.joinMessageTs) posts.push({ ts: fire.joinMessageTs, which: "meeting" });
  return posts;
}

/** Caller passes an already-fresh `fire` — state may have just changed. */
export async function repost(
  client: WebClient,
  fire: Fire,
  reminder: Reminder,
  channelId: string,
  logger: Logger,
): Promise<void> {
  const hasRoster = listHosts(reminder.id).length > 0;
  const skips = listSkips(fire.id);
  const reporters = listReports(fire.id);
  const names = await postNames(client, logger, { skips, reporters });

  for (const { ts, which } of postsOf(fire, reminder)) {
    const post = {
      code: reminder.code,
      ...reminderBody(reminder, which),
      host: fire.hostUserId ?? undefined,
      // A rostered reminder always names a host when it fires, so losing one means
      // a handover found nobody available.
      hostUnavailable: hasRoster && !fire.hostUserId,
      skips,
      reporters,
      names,
      skippable: hasRoster,
    };

    await client.chat.update({
      channel: channelId,
      ts,
      blocks: reminderBlocks(post),
      text: fallbackText(post),
    });
  }
}
