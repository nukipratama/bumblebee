import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { pendingLap } from "../../../src/domain/rotation.js";
import type { Fire, Reminder } from "../../../src/domain/types.js";
import { newReminder, useTempDatabase } from "../../helpers/store.js";

useTempDatabase();

const { initDb, stmt } = await import("../../../src/store/database.js");
const {
  getFireByMessageTs,
  getReminder,
  insertReminder,
  listHosts,
  listSkips,
  recordFire,
  replaceHosts,
} = await import("../../../src/store/reminders.js");
const { applySkip } = await import("../../../src/slack/listeners/skip.js");

initDb();

const MINUTES = 60_000;
const MESSAGE_TS = "1700000000.0001";

beforeEach(() => {
  stmt("DELETE FROM reminders").run();
});

/** A reminder that has already fired, with `host` named on the post. */
function fired(roster: string[], lap: string[], firedMinutesAgo = 0): [Fire, Reminder] {
  const reminder = newReminder();
  insertReminder(reminder);
  const stored = getReminder(reminder.channelId, reminder.code)!;

  replaceHosts(stored.id, roster, lap);
  recordFire({
    reminderId: stored.id,
    firedOn: "2026-07-27",
    firedAt: new Date(Date.now() - firedMinutesAgo * MINUTES),
    hostUserId: lap[0] ?? null,
    messageTs: MESSAGE_TS,
    nextLap: lap.slice(1),
  });

  return [getFireByMessageTs(MESSAGE_TS)!, stored];
}

describe("the host hands over", () => {
  it("names the next person in the lap as the host of this occurrence", () => {
    const [fire, reminder] = fired(["U_A", "U_B", "U_C"], ["U_A", "U_B", "U_C"]);

    const outcome = applySkip(fire, reminder, "U_A", Date.now());

    assert.equal(getFireByMessageTs(MESSAGE_TS)?.hostUserId, "U_B");
    assert.match(outcome.thread ?? "", /<@U_B> is hosting today instead/);
  });

  it("marks the outgoing host as out today", () => {
    const [fire, reminder] = fired(["U_A", "U_B"], ["U_A", "U_B"]);

    applySkip(fire, reminder, "U_A", Date.now());

    assert.deepEqual(listSkips(fire.id), ["U_A"]);
  });

  it("keeps their turn by sending them to the back of the lap", () => {
    const [fire, reminder] = fired(["U_A", "U_B", "U_C"], ["U_A", "U_B", "U_C"]);

    applySkip(fire, reminder, "U_A", Date.now());

    assert.deepEqual(pendingLap(listHosts(reminder.id)), ["U_C", "U_A"]);
  });

  it("draws a fresh lap that avoids them when this fire closed the lap", () => {
    const [fire, reminder] = fired(["U_A", "U_B", "U_C"], ["U_A"]);

    applySkip(fire, reminder, "U_A", Date.now());

    const replacement = getFireByMessageTs(MESSAGE_TS)!.hostUserId;
    assert.notEqual(replacement, "U_A");
    assert.ok(["U_B", "U_C"].includes(replacement!));
  });

  it("passes over someone who already marked themselves out today", () => {
    const [fire, reminder] = fired(["U_A", "U_B", "U_C"], ["U_A", "U_B", "U_C"]);
    applySkip(fire, reminder, "U_B", Date.now());

    applySkip(fire, reminder, "U_A", Date.now());

    assert.equal(getFireByMessageTs(MESSAGE_TS)?.hostUserId, "U_C");
  });

  it("leaves whoever was passed over in place, since being out costs no turn", () => {
    const [fire, reminder] = fired(["U_A", "U_B", "U_C"], ["U_A", "U_B", "U_C"]);
    applySkip(fire, reminder, "U_B", Date.now());

    applySkip(fire, reminder, "U_A", Date.now());

    assert.deepEqual(pendingLap(listHosts(reminder.id)), ["U_B", "U_A"]);
  });

  it("leaves nobody hosting when everyone left in the lap is out", () => {
    const [fire, reminder] = fired(["U_A", "U_B", "U_C"], ["U_A", "U_B", "U_C"]);
    applySkip(fire, reminder, "U_B", Date.now());
    applySkip(fire, reminder, "U_C", Date.now());

    const outcome = applySkip(fire, reminder, "U_A", Date.now());

    assert.equal(getFireByMessageTs(MESSAGE_TS)?.hostUserId, null);
    assert.match(outcome.thread ?? "", /nobody is hosting/);
  });

  it("still marks the clicker out and keeps their turn when nobody can take over", () => {
    const [fire, reminder] = fired(["U_A", "U_B"], ["U_A", "U_B"]);
    applySkip(fire, reminder, "U_B", Date.now());

    applySkip(fire, reminder, "U_A", Date.now());

    assert.deepEqual(listSkips(fire.id).sort(), ["U_A", "U_B"]);
    assert.deepEqual(pendingLap(listHosts(reminder.id)), ["U_B", "U_A"]);
  });

  it("refuses when they are the only person on the rotation", () => {
    const [fire, reminder] = fired(["U_A"], ["U_A"]);

    const outcome = applySkip(fire, reminder, "U_A", Date.now());

    assert.match(outcome.ephemeral ?? "", /only person/);
    assert.equal(getFireByMessageTs(MESSAGE_TS)?.hostUserId, "U_A");
    assert.deepEqual(listSkips(fire.id), []);
  });
});

describe("the handover window", () => {
  it("is open within 30 minutes of the fire", () => {
    const [fire, reminder] = fired(["U_A", "U_B"], ["U_A", "U_B"], 29);

    applySkip(fire, reminder, "U_A", Date.now());

    assert.equal(getFireByMessageTs(MESSAGE_TS)?.hostUserId, "U_B");
  });

  it("is closed after 30 minutes, changing nothing at all", () => {
    const [fire, reminder] = fired(["U_A", "U_B"], ["U_A", "U_B"], 31);

    const outcome = applySkip(fire, reminder, "U_A", Date.now());

    assert.match(outcome.ephemeral ?? "", /too late to hand over/);
    assert.equal(getFireByMessageTs(MESSAGE_TS)?.hostUserId, "U_A");
    assert.deepEqual(listSkips(fire.id), []);
    assert.deepEqual(pendingLap(listHosts(reminder.id)), ["U_B"]);
  });

  it("treats a fire predating the fired_at column as too old to hand over", () => {
    const [fire, reminder] = fired(["U_A", "U_B"], ["U_A", "U_B"]);
    stmt("UPDATE reminder_fires SET fired_at = NULL WHERE id = ?").run(fire.id);
    const legacy = getFireByMessageTs(MESSAGE_TS)!;

    const outcome = applySkip(legacy, reminder, "U_A", Date.now());

    assert.match(outcome.ephemeral ?? "", /too late to hand over/);
    assert.equal(getFireByMessageTs(MESSAGE_TS)?.hostUserId, "U_A");
  });
});

describe("anyone who is not the host", () => {
  it("marks a roster member out without touching the rotation", () => {
    const [fire, reminder] = fired(["U_A", "U_B"], ["U_A", "U_B"]);

    const outcome = applySkip(fire, reminder, "U_B", Date.now());

    assert.deepEqual(outcome, {});
    assert.deepEqual(listSkips(fire.id), ["U_B"]);
    assert.equal(getFireByMessageTs(MESSAGE_TS)?.hostUserId, "U_A");
    assert.deepEqual(pendingLap(listHosts(reminder.id)), ["U_B"]);
  });

  it("marks someone who is not on the rotation at all out", () => {
    const [fire, reminder] = fired(["U_A", "U_B"], ["U_A", "U_B"]);

    applySkip(fire, reminder, "U_OUTSIDER", Date.now());

    assert.deepEqual(listSkips(fire.id), ["U_OUTSIDER"]);
    assert.equal(listHosts(reminder.id).length, 2);
  });

  it("says so rather than listing them twice on a second click", () => {
    const [fire, reminder] = fired(["U_A", "U_B"], ["U_A", "U_B"]);
    applySkip(fire, reminder, "U_B", Date.now());

    const outcome = applySkip(fire, reminder, "U_B", Date.now());

    assert.match(outcome.ephemeral ?? "", /already down as out/);
    assert.deepEqual(listSkips(fire.id), ["U_B"]);
  });

  it("tells the outgoing host they are already out if they click again", () => {
    const [fire, reminder] = fired(["U_A", "U_B"], ["U_A", "U_B"]);
    applySkip(fire, reminder, "U_A", Date.now());

    const again = applySkip(getFireByMessageTs(MESSAGE_TS)!, reminder, "U_A", Date.now());

    assert.match(again.ephemeral ?? "", /already down as out/);
    assert.deepEqual(listSkips(fire.id), ["U_A"]);
  });
});
