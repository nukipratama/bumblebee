import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { pendingLap } from "../../../../src/domain/rotation.js";
import type { Reminder } from "../../../../src/domain/types.js";
import type { PendingAction, PendingEntry } from "../../../../src/slack/pending.js";
import { fakeClient, newReminder, useTempDatabase } from "../../../helpers/store.js";

useTempDatabase();

const { initDb, stmt } = await import("../../../../src/store/database.js");
const { getHoliday, getReminder, insertReminder, listHosts, replaceHosts } = await import(
  "../../../../src/store/reminders.js"
);
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

const apply = (action: PendingAction) => applyAction(entry(action), fakeClient().client);

describe("add", () => {
  it("inserts the reminder and announces it in the channel", async () => {
    const result = await apply({ kind: "add", reminder: newReminder() });

    assert.equal(getReminder("C1", "standup")?.message, "Standup time!");
    assert.match(result.ephemeral, /Added/);
    assert.match(result.channel ?? "", /<@U_ACTOR> added reminder `standup`/);
  });

  it("adds nothing when the code was taken between the prompt and the click", async () => {
    seed();

    const result = await apply({ kind: "add", reminder: newReminder({ message: "different" }) });

    assert.match(result.ephemeral, /already exists now — nothing added/);
    assert.equal(result.channel, undefined);
    assert.equal(getReminder("C1", "standup")?.message, "Standup time!");
  });
});

describe("edit", () => {
  it("applies only the fields that changed", async () => {
    seed({ at: "09:00", days: "monday" });

    await apply({ kind: "edit", code: "standup", changes: { at: "10:30" } });

    const updated = getReminder("C1", "standup")!;
    assert.equal(updated.at, "10:30");
    assert.equal(updated.days, "monday");
  });

  it("changes nothing when the reminder is gone", async () => {
    const result = await apply({ kind: "edit", code: "standup", changes: { at: "10:30" } });

    assert.match(result.ephemeral, /no longer exists — nothing changed/);
    assert.equal(result.channel, undefined);
  });

  it("refuses an edit that a since-changed reminder would make invalid", async () => {
    seed({ days: "monday,tuesday", everyNWeeks: 1 });

    const result = await apply({
      kind: "edit",
      code: "standup",
      changes: { everyNWeeks: 2 },
    });

    assert.match(result.ephemeral, /changed since you asked/);
    assert.equal(getReminder("C1", "standup")?.everyNWeeks, 1);
  });
});

describe("remove and pause", () => {
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

  it("pauses and resumes", async () => {
    seed();

    await apply({ kind: "setEnabled", code: "standup", enabled: false });
    assert.equal(getReminder("C1", "standup")?.enabled, false);

    const resumed = await apply({ kind: "setEnabled", code: "standup", enabled: true });
    assert.equal(getReminder("C1", "standup")?.enabled, true);
    assert.match(resumed.channel ?? "", /resumed reminder/);
  });
});

describe("host rotation", () => {
  it("replaces the roster and names who is up next", async () => {
    const reminder = seed();

    const result = await apply({
      kind: "hostSet",
      code: "standup",
      userIds: ["U_A", "U_B", "U_C"],
    });

    assert.equal(listHosts(reminder.id).length, 3);
    assert.match(result.channel ?? "", /is up next/);
  });

  it("keeps whoever already hosted out of the new lap", async () => {
    const reminder = seed();
    replaceHosts(reminder.id, ["U_A", "U_B"], ["U_B"]);

    await apply({ kind: "hostSet", code: "standup", userIds: ["U_A", "U_B", "U_C"] });

    assert.ok(!pendingLap(listHosts(reminder.id)).includes("U_A"));
  });

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

  it("clears the rotation", async () => {
    const reminder = seed();
    replaceHosts(reminder.id, ["U_A", "U_B"], ["U_A", "U_B"]);

    await apply({ kind: "hostClear", code: "standup" });

    assert.deepEqual(listHosts(reminder.id), []);
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

    const result = await applyAction(entry({ kind: "run", code: "standup" }), client);

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

    const result = await applyAction(entry({ kind: "run", code: "standup" }), client);

    assert.equal(posted.length, 0);
    assert.match(result.ephemeral, /Skipped `standup`: cadence/);
  });
});
