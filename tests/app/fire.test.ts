import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { localParts } from "../../src/domain/clock.js";
import { pendingLap } from "../../src/domain/rotation.js";
import type { Reminder } from "../../src/domain/types.js";
import { fakeClient, newReminder, useTempDatabase } from "../helpers/store.js";

useTempDatabase();

const { initDb, stmt } = await import("../../src/store/database.js");
const {
  getFireByMessageTs,
  getReminder,
  getReminderById,
  insertHoliday,
  insertReminder,
  listHosts,
  replaceHosts,
  setFireHost,
} = await import("../../src/store/reminders.js");
const { fireReminder, postJoin } = await import("../../src/app/fire.js");

initDb();

/** Read per-test, not once at load: the suite must not care if it straddles midnight. */
const today = (): string => localParts(new Date()).date;

beforeEach(() => {
  stmt("DELETE FROM reminders").run();
  stmt("DELETE FROM holidays").run();
});

function seed(overrides: Parameters<typeof newReminder>[0] = {}): Reminder {
  const reminder = newReminder(overrides);
  insertReminder(reminder);
  return getReminder(reminder.channelId, reminder.code)!;
}

function withRoster(userIds: string[], lap = userIds): Reminder {
  const reminder = seed();
  replaceHosts(reminder.id, userIds, lap);
  return reminder;
}

const daysAgo = (days: number): string =>
  new Date(Date.now() - days * 86_400_000).toISOString();

describe("fireReminder — posting", () => {
  it("posts the message and reports the host who was up", async () => {
    const reminder = withRoster(["U_A", "U_B"]);
    const { client, posted } = fakeClient();

    const outcome = await fireReminder(reminder, client, "meeting");

    assert.deepEqual(outcome, { posted: true, host: "U_A" });
    assert.equal(posted.length, 1);
    assert.equal(posted[0]!.channel, "C1");
  });

  it("advances the lap and stamps the fire once the post succeeds", async () => {
    const reminder = withRoster(["U_A", "U_B"]);
    const { client } = fakeClient(async () => ({ ts: "999.9" }));

    await fireReminder(reminder, client, "meeting");

    assert.deepEqual(pendingLap(listHosts(reminder.id)), ["U_B"]);
    assert.notEqual(getReminderById(reminder.id)?.lastFiredAt, null);
    assert.equal(getFireByMessageTs("999.9")?.hostUserId, "U_A");
  });

  it("draws a fresh lap containing everyone when the last host fires", async () => {
    const reminder = withRoster(["U_A", "U_B"], ["U_B"]);
    const { client } = fakeClient();

    await fireReminder(reminder, client, "meeting");

    assert.deepEqual(pendingLap(listHosts(reminder.id)).sort(), ["U_A", "U_B"]);
  });

  it("posts with no host when the reminder has no roster", async () => {
    const reminder = seed();
    const { client } = fakeClient();

    const outcome = await fireReminder(reminder, client, "meeting");

    assert.deepEqual(outcome, { posted: true, host: undefined });
  });
});

describe("fireReminder — a failed post costs nobody their turn", () => {
  it("propagates the Slack error rather than swallowing it", async () => {
    const reminder = withRoster(["U_A", "U_B"]);
    const { client } = fakeClient(async () => {
      throw new Error("slack is down");
    });

    await assert.rejects(() => fireReminder(reminder, client, "meeting"), /slack is down/);
  });

  it("leaves the lap untouched, so the same person is still up next", async () => {
    const reminder = withRoster(["U_A", "U_B"]);
    const { client } = fakeClient(async () => {
      throw new Error("slack is down");
    });

    await fireReminder(reminder, client, "meeting").catch(() => undefined);

    assert.deepEqual(pendingLap(listHosts(reminder.id)), ["U_A", "U_B"]);
  });

  it("records neither the fire stamp nor a history row", async () => {
    const reminder = withRoster(["U_A", "U_B"]);
    const { client } = fakeClient(async () => {
      throw new Error("slack is down");
    });

    await fireReminder(reminder, client, "meeting").catch(() => undefined);

    assert.equal(getReminderById(reminder.id)?.lastFiredAt, null);
    const fires = stmt("SELECT COUNT(*) AS n FROM reminder_fires WHERE reminder_id = ?").get(
      reminder.id,
    ) as unknown as { n: number };
    assert.equal(fires.n, 0);
  });
});

describe("fireReminder — guards", () => {
  it("skips a holiday without posting or recording anything", async () => {
    const reminder = withRoster(["U_A", "U_B"]);
    insertHoliday({ date: today(), addedBy: "U_X", addedInChannel: "C1" });
    const { client, posted } = fakeClient();

    const outcome = await fireReminder(reminder, client, "meeting");

    assert.equal(outcome.posted, false);
    assert.match(outcome.posted === false ? outcome.reason : "", /holiday/);
    assert.equal(posted.length, 0);
    assert.deepEqual(pendingLap(listHosts(reminder.id)), ["U_A", "U_B"]);
    assert.equal(getReminderById(reminder.id)?.lastFiredAt, null);
  });

  it("skips when the cadence gap has not elapsed", async () => {
    const reminder = seed({ everyNWeeks: 2 });
    stmt("UPDATE reminders SET last_fired_at = ? WHERE id = ?").run(daysAgo(3), reminder.id);
    const { client, posted } = fakeClient();

    const outcome = await fireReminder(getReminderById(reminder.id)!, client, "meeting");

    assert.equal(outcome.posted, false);
    assert.match(outcome.posted === false ? outcome.reason : "", /cadence/);
    assert.equal(posted.length, 0);
  });

  it("posts once the cadence gap has elapsed", async () => {
    const reminder = seed({ everyNWeeks: 2 });
    stmt("UPDATE reminders SET last_fired_at = ? WHERE id = ?").run(daysAgo(14), reminder.id);
    const { client } = fakeClient();

    const outcome = await fireReminder(getReminderById(reminder.id)!, client, "meeting");

    assert.equal(outcome.posted, true);
  });
});

describe("fireReminder — the post itself", () => {
  const blockTypes = (blocks: unknown[] | undefined): string[] =>
    (blocks ?? []).map((block) => (block as { type: string }).type);

  it("carries a Skip me button only when someone could take over", async () => {
    const rotating = withRoster(["U_A", "U_B"]);
    const { client, posted } = fakeClient();
    await fireReminder(rotating, client, "meeting");

    assert.ok(blockTypes(posted[0]!.blocks).includes("actions"));

    stmt("DELETE FROM reminders").run();
    const plain = seed({ code: "plain" });
    const solo = fakeClient();
    await fireReminder(plain, solo.client, "meeting");

    assert.ok(!blockTypes(solo.posted[0]!.blocks).includes("actions"));
  });

  it("suppresses the link card, which outlives every later update of the post", async () => {
    const reminder = seed({ message: "Standup — https://meet.google.com/abc-defg-hij" });
    const { client, posted } = fakeClient();
    await fireReminder(reminder, client, "meeting");

    assert.equal(posted[0]!.unfurl_links, false);
    assert.equal(posted[0]!.unfurl_media, false);
  });

  it("renders each body dialect through its own block, never converting", async () => {
    const reminder = seed({ bodyFormat: "mrkdwn", message: "*bold in Slack*" });
    const { client, posted } = fakeClient();

    await fireReminder(reminder, client, "meeting");

    assert.deepEqual(posted[0]!.blocks?.[0], {
      type: "section",
      text: { type: "mrkdwn", text: "*bold in Slack*" },
    });
  });

  it("always sends fallback text, so notifications are never empty", async () => {
    const reminder = withRoster(["U_A"]);
    const { client, posted } = fakeClient();

    await fireReminder(reminder, client, "meeting");

    assert.ok((posted[0]!.text ?? "").length > 0);
  });
});

describe("fireReminder — the heads-up body", () => {
  const lead = { leadMinutes: 55, preMessage: "Daily Standup", at: "10:25" };

  it("prefixes the pre-message with the meeting time", async () => {
    const reminder = seed(lead);
    const { client, posted } = fakeClient();

    await fireReminder(reminder, client, "heads-up");

    assert.deepEqual(posted[0]!.blocks?.[0], {
      type: "markdown",
      text: "Heads Up at 10:25: Daily Standup",
    });
  });

  it("posts the meeting body untouched when that is what was asked for", async () => {
    const reminder = seed(lead);
    const { client, posted } = fakeClient();

    await fireReminder(reminder, client, "meeting");

    assert.deepEqual(posted[0]!.blocks?.[0], { type: "markdown", text: "Standup time!" });
  });

  it("falls back to the meeting body rather than posting a bare prefix", async () => {
    const reminder = seed({ leadMinutes: 55, preMessage: null });
    const { client, posted } = fakeClient();

    await fireReminder(reminder, client, "heads-up");

    assert.deepEqual(posted[0]!.blocks?.[0], { type: "markdown", text: "Standup time!" });
  });
});

describe("postJoin", () => {
  const lead = { leadMinutes: 55, preMessage: "Daily Standup" };

  it("names the host the early fire settled on, and posts the meeting body", async () => {
    const reminder = seed(lead);
    replaceHosts(reminder.id, ["U_A", "U_B"], ["U_A", "U_B"]);
    const { client, posted } = fakeClient();
    await fireReminder(reminder, client, "heads-up");

    const outcome = await postJoin(reminder, client);

    assert.deepEqual(outcome, { posted: true, host: "U_A" });
    assert.deepEqual(posted[1]!.blocks?.[0], { type: "markdown", text: "Standup time!" });
  });

  it("names the replacement when a handover happened since the heads-up", async () => {
    const reminder = seed(lead);
    replaceHosts(reminder.id, ["U_A", "U_B"], ["U_A", "U_B"]);
    const { client } = fakeClient(async () => ({ ts: "999.9" }));
    await fireReminder(reminder, client, "heads-up");
    setFireHost(getFireByMessageTs("999.9")!.id, "U_B");

    const outcome = await postJoin(reminder, client);

    assert.deepEqual(outcome, { posted: true, host: "U_B" });
  });

  it("records its own message ts, so the button on it finds the same fire", async () => {
    const reminder = seed(lead);
    const { client } = fakeClient(async () => ({ ts: "999.9" }));
    await fireReminder(reminder, client, "heads-up");

    await postJoin(reminder, client);

    assert.equal(getFireByMessageTs("999.9")?.joinMessageTs, "999.9");
  });

  it("fires outright when the lead time was missed, so nobody loses their turn", async () => {
    const reminder = seed(lead);
    replaceHosts(reminder.id, ["U_A", "U_B"], ["U_A", "U_B"]);
    const { client, posted } = fakeClient();

    const outcome = await postJoin(reminder, client);

    assert.deepEqual(outcome, { posted: true, host: "U_A" });
    assert.equal(posted.length, 1);
    assert.deepEqual(pendingLap(listHosts(reminder.id)), ["U_B"]);
  });

  it("advances the lap exactly once across both posts", async () => {
    const reminder = seed(lead);
    replaceHosts(reminder.id, ["U_A", "U_B", "U_C"], ["U_A", "U_B", "U_C"]);
    const { client } = fakeClient();

    await fireReminder(reminder, client, "heads-up");
    await postJoin(getReminderById(reminder.id)!, client);

    assert.deepEqual(pendingLap(listHosts(reminder.id)), ["U_B", "U_C"]);
  });

  it("posts nothing on a holiday, having never fired that day", async () => {
    const reminder = seed(lead);
    insertHoliday({ date: today(), addedBy: "U_A", addedInChannel: "C1" });
    const { client, posted } = fakeClient();

    const outcome = await postJoin(reminder, client);

    assert.equal(outcome.posted, false);
    assert.equal(posted.length, 0);
  });
});
