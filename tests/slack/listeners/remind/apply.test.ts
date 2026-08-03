import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { localParts } from "../../../../src/domain/clock.js";
import { pendingLap } from "../../../../src/domain/rotation.js";
import type { Reminder } from "../../../../src/domain/types.js";
import type { PendingAction, PendingEntry } from "../../../../src/slack/pending.js";
import { fakeClient, fakeLogger, newReminder, useTempDatabase } from "../../../helpers/store.js";

useTempDatabase();

const { initDb, stmt } = await import("../../../../src/store/database.js");
const {
  addSkip,
  getFireForDate,
  getHoliday,
  getReminder,
  insertReminder,
  listHosts,
  recordFire,
  replaceHosts,
} = await import("../../../../src/store/reminders.js");
const { applyAction } = await import("../../../../src/slack/listeners/remind/apply.js");

initDb();

const ACTOR = "U_ACTOR";

beforeEach(() => {
  stmt("DELETE FROM reminders").run();
  stmt("DELETE FROM holidays").run();
});

const entry = (action: PendingAction): PendingEntry => ({
  action,
  userId: ACTOR,
  channelId: "C1",
  createdAt: Date.now(),
});

function seed(overrides: Parameters<typeof newReminder>[0] = {}): Reminder {
  const reminder = newReminder(overrides);
  insertReminder(reminder);
  return getReminder(reminder.channelId, reminder.code)!;
}

const apply = (action: PendingAction) =>
  applyAction(entry(action), fakeClient().client, fakeLogger());

describe("remove", () => {
  it("removes the reminder", async () => {
    seed();

    const result = await apply({ kind: "remove", code: "standup" });

    assert.equal(getReminder("C1", "standup"), undefined);
    assert.match(result.channel ?? "", /removed reminder/);
  });

  it("reports nothing removed when it is already gone", async () => {
    const result = await apply({ kind: "remove", code: "standup" });

    assert.match(result.ephemeral, /nothing removed/);
  });

});

describe("host rotation", () => {
  it("sends the person who is up to the back of the lap on skip", async () => {
    const reminder = seed();
    replaceHosts(reminder.id, ["U_A", "U_B", "U_C"], ["U_A", "U_B", "U_C"]);

    const result = await apply({ kind: "hostSkip", code: "standup" });

    assert.deepEqual(pendingLap(listHosts(reminder.id)), ["U_B", "U_C", "U_A"]);
    assert.match(result.channel ?? "", /skipped <@U_A>/);
  });

  it("rolls a closing lap over rather than landing back on the skipped person", async () => {
    const reminder = seed();
    replaceHosts(reminder.id, ["U_A", "U_B", "U_C"], ["U_A"]);

    await apply({ kind: "hostSkip", code: "standup" });

    const lap = pendingLap(listHosts(reminder.id));
    assert.equal(lap.length, 3);
    assert.notEqual(lap[0], "U_A");
  });

  it("changes nothing when the roster shrank below two people", async () => {
    const reminder = seed();
    replaceHosts(reminder.id, ["U_A"], ["U_A"]);

    const result = await apply({ kind: "hostSkip", code: "standup" });

    assert.match(result.ephemeral, /no longer has enough people to skip/);
    assert.deepEqual(pendingLap(listHosts(reminder.id)), ["U_A"]);
  });

  it("puts someone up next", async () => {
    const reminder = seed();
    replaceHosts(reminder.id, ["U_A", "U_B", "U_C"], ["U_A", "U_B", "U_C"]);

    await apply({ kind: "hostNext", code: "standup", userId: "U_C" });

    assert.equal(pendingLap(listHosts(reminder.id))[0], "U_C");
  });

  it("changes nothing when that person left the roster since the prompt", async () => {
    const reminder = seed();
    replaceHosts(reminder.id, ["U_A", "U_B"], ["U_A", "U_B"]);

    const result = await apply({ kind: "hostNext", code: "standup", userId: "U_GONE" });

    assert.match(result.ephemeral, /no longer on/);
    assert.deepEqual(pendingLap(listHosts(reminder.id)), ["U_A", "U_B"]);
  });
});

describe("holidays", () => {
  it("adds one and says it applies everywhere", async () => {
    const result = await apply({ kind: "holidayAdd", date: "2026-08-17" });

    assert.equal(getHoliday("2026-08-17")?.addedBy, ACTOR);
    assert.match(result.channel ?? "", /every channel/);
  });

  it("does not add one twice", async () => {
    await apply({ kind: "holidayAdd", date: "2026-08-17" });

    const result = await apply({ kind: "holidayAdd", date: "2026-08-17" });

    assert.match(result.ephemeral, /already a holiday/);
    assert.equal(result.channel, undefined);
  });

  it("removes one", async () => {
    await apply({ kind: "holidayAdd", date: "2026-08-17" });

    await apply({ kind: "holidayRemove", date: "2026-08-17" });

    assert.equal(getHoliday("2026-08-17"), undefined);
  });
});

describe("run", () => {
  it("posts immediately and reports that the host's turn was used", async () => {
    const reminder = seed();
    replaceHosts(reminder.id, ["U_A", "U_B"], ["U_A", "U_B"]);
    const { client, posted } = fakeClient();

    const result = await applyAction(entry({ kind: "run", code: "standup" }), client, fakeLogger());

    assert.equal(posted.length, 1);
    assert.match(result.ephemeral, /Posted `standup`.*turn is used/);
    assert.deepEqual(pendingLap(listHosts(reminder.id)), ["U_B"]);
  });

  it("reports the guard that stopped it rather than posting", async () => {
    const reminder = seed({ everyNWeeks: 2 });
    stmt("UPDATE reminders SET last_fired_at = ? WHERE id = ?").run(
      new Date(Date.now() - 86_400_000).toISOString(),
      reminder.id,
    );
    const { client, posted } = fakeClient();

    const result = await applyAction(entry({ kind: "run", code: "standup" }), client, fakeLogger());

    assert.equal(posted.length, 0);
    assert.match(result.ephemeral, /Skipped `standup`: cadence/);
  });
});

describe("host current", () => {
  const TODAY = localParts(new Date()).date;
  // Within the 30-minute window regardless of when the test suite happens to run.
  const NOW_TIME = localParts(new Date()).time;
  const MESSAGE_TS = "1700000000.0001";

  function fireToday(reminder: Reminder, hostUserId: string | null): void {
    recordFire({
      reminderId: reminder.id,
      firedOn: TODAY,
      firedAt: new Date(),
      hostUserId,
      messageTs: MESSAGE_TS,
      nextLap: [],
    });
  }

  const hostCurrent = (userId: string): PendingAction => ({
    kind: "hostCurrent",
    code: "standup",
    userId,
  });

  it("sets the new host and reposts the live message", async () => {
    const reminder = seed({ at: NOW_TIME });
    replaceHosts(reminder.id, ["U_A", "U_B"], ["U_A", "U_B"]);
    fireToday(reminder, "U_A");
    const { client, updated } = fakeClient();

    const result = await applyAction(entry(hostCurrent("U_B")), client, fakeLogger());

    assert.equal(getFireForDate(reminder.id, TODAY)?.hostUserId, "U_B");
    assert.equal(updated.length, 1);
    assert.match(result.ephemeral, /<@U_B> is now hosting/);
    assert.match(result.channel ?? "", /set <@U_B> as the current host/);
  });

  it("refuses when nothing has fired today", async () => {
    const reminder = seed();
    replaceHosts(reminder.id, ["U_A", "U_B"], ["U_A", "U_B"]);
    const { client } = fakeClient();

    const result = await applyAction(entry(hostCurrent("U_B")), client, fakeLogger());

    assert.match(result.ephemeral, /hasn't fired yet today/);
  });

  it("refuses to pick the person already hosting", async () => {
    const reminder = seed({ at: NOW_TIME });
    replaceHosts(reminder.id, ["U_A", "U_B"], ["U_A", "U_B"]);
    fireToday(reminder, "U_A");
    const { client } = fakeClient();

    const result = await applyAction(entry(hostCurrent("U_A")), client, fakeLogger());

    assert.match(result.ephemeral, /already hosting/);
  });

  it("refuses a target who is not on the roster", async () => {
    const reminder = seed({ at: NOW_TIME });
    replaceHosts(reminder.id, ["U_A", "U_B"], ["U_A", "U_B"]);
    fireToday(reminder, "U_A");
    const { client } = fakeClient();

    const result = await applyAction(entry(hostCurrent("U_OUTSIDER")), client, fakeLogger());

    assert.match(result.ephemeral, /not on the rotation/);
  });

  it("refuses to set someone who already skipped today", async () => {
    const reminder = seed({ at: NOW_TIME });
    replaceHosts(reminder.id, ["U_A", "U_B"], ["U_A", "U_B"]);
    fireToday(reminder, "U_A");
    addSkip(getFireForDate(reminder.id, TODAY)!.id, "U_B", null);
    const { client } = fakeClient();

    const result = await applyAction(entry(hostCurrent("U_B")), client, fakeLogger());

    assert.match(result.ephemeral, /already skipped/);
    assert.equal(getFireForDate(reminder.id, TODAY)?.hostUserId, "U_A");
  });

  it("reports an accurate message when reposting the live message fails", async () => {
    const reminder = seed({ at: NOW_TIME });
    replaceHosts(reminder.id, ["U_A", "U_B"], ["U_A", "U_B"]);
    fireToday(reminder, "U_A");
    const { client } = fakeClient(undefined, async () => {
      throw new Error("message not found");
    });

    const result = await applyAction(entry(hostCurrent("U_B")), client, fakeLogger());

    assert.equal(getFireForDate(reminder.id, TODAY)?.hostUserId, "U_B");
    assert.match(result.ephemeral, /couldn't update the live post/);
  });
});
