import type { WebClient } from "@slack/web-api";

/**
 * static_select options need plain-text labels — unlike mrkdwn, Slack won't
 * resolve a `<@id>` mention there, so the real display name has to be fetched.
 */
export async function resolveDisplayNames(
  client: WebClient,
  userIds: readonly string[],
): Promise<Map<string, string>> {
  const entries = await Promise.all(
    userIds.map(async (userId): Promise<[string, string]> => {
      try {
        const { user } = await client.users.info({ user: userId });
        return [userId, user?.profile?.display_name || user?.real_name || user?.name || userId];
      } catch {
        return [userId, userId];
      }
    }),
  );
  return new Map(entries);
}
