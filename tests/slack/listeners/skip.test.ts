import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { pendingLap } from "../../../src/domain/rotation.js";
import type { Fire, NewReminder, Reminder } from "../../../src/domain/types.js";
import { newReminder, useTempDatabase } from "../../helpers/store.js";

useTempDatabase();

const { initDb, stmt } = await import("../../../src/store/database.js");
const {
  getFireByMessageTs,
  getReminder,
  getSkip,
  insertReminder,
  listHosts,
  listSkips,
  recordFire,
  replaceHosts,
  setJoinMessageTs,
} = await import("../../../src/store/reminders.js");
const { applySkip } = await import("../../../src/slack/listeners/skip.js");

initDb();

const MINUTES = 60_000;
const MESSAGE_TS = "1700000000.0001";
const JOIN_TS = "1700000000.0002";
const FIRED_ON = "2026-07-27";
const AT = "09:00";

/** The window runs from the meeting, so every `now` in here is relative to it. */
const MEETING = new Date(`${FIRED_ON}T${AT}:00`).getTime();
const fromMeeting = (minutes: number): number => MEETING + minutes * MINUTES;

beforeEach(() => {
  stmt("DELETE FROM reminders").run();
});

/** A reminder that has already fired, with `host` named on the post. */
function fired(
  roster: string[],
  lap: string[],
  overrides: Partial<NewReminder> = {},
): [Fire, Reminder] {
  const reminder = newReminder({ at: AT, ...overrides });
  insertReminder(reminder);
  const stored = getReminder(reminder.channelId, reminder.code)!;

  replaceHosts(stored.id, roster, lap);
  recordFire({
    reminderId: stored.id,
    firedOn: FIRED_ON,
    firedAt: new Date(MEETING),
    hostUserId: lap[0] ?? null,
    messageTs: MESSAGE_TS,
    nextLap: lap.slice(1),
  });

  return [getFireByMessageTs(MESSAGE_TS)!, stored];
}

const skipIds = (fireId: number): string[] => listSkips(fireId).map((skip) => skip.userId);

/** SQLite hands back null-prototype rows, which never deep-equal an object literal. */
const skipRows = (fireId: number) => listSkips(fireId).map((skip) => ({ ...skip }));

describe("the host hands over", () => {
  it("names the next person in the lap as the host of this occurrence", () => {
    const [fire, reminder] = fired(["U_A", "U_B", "U_C"], ["U_A", "U_B", "U_C"]);

    const outcome = applySkip({ fire, reminder, clicker: "U_A", now: MEETING });

    assert.equal(getFireByMessageTs(MESSAGE_TS)?.hostUserId, "U_B");
    assert.match(outcome.handover ?? "", /<@U_B> is hosting instead/);
  });

  it("marks the outgoing host as skipping", () => {
    const [fire, reminder] = fired(["U_A", "U_B"], ["U_A", "U_B"]);

    applySkip({ fire, reminder, clicker: "U_A", now: MEETING });

    assert.deepEqual(skipIds(fire.id), ["U_A"]);
  });

  it("keeps their turn by sending them to the back of the lap", () => {
    const [fire, reminder] = fired(["U_A", "U_B", "U_C"], ["U_A", "U_B", "U_C"]);

    applySkip({ fire, reminder, clicker: "U_A", now: MEETING });

    assert.deepEqual(pendingLap(listHosts(reminder.id)), ["U_C", "U_A"]);
  });

  it("draws a fresh lap that avoids them when this fire closed the lap", () => {
    const [fire, reminder] = fired(["U_A", "U_B", "U_C"], ["U_A"]);

    applySkip({ fire, reminder, clicker: "U_A", now: MEETING });

    const replacement = getFireByMessageTs(MESSAGE_TS)!.hostUserId;
    assert.notEqual(replacement, "U_A");
    assert.ok(["U_B", "U_C"].includes(replacement!));
  });

  it("passes over someone who is already down as skipping", () => {
    const [fire, reminder] = fired(["U_A", "U_B", "U_C"], ["U_A", "U_B", "U_C"]);
    applySkip({ fire, reminder, clicker: "U_B", now: MEETING });

    applySkip({ fire, reminder, clicker: "U_A", now: MEETING });

    assert.equal(getFireByMessageTs(MESSAGE_TS)?.hostUserId, "U_C");
  });

  it("leaves whoever was passed over in place, since skipping costs no turn", () => {
    const [fire, reminder] = fired(["U_A", "U_B", "U_C"], ["U_A", "U_B", "U_C"]);
    applySkip({ fire, reminder, clicker: "U_B", now: MEETING });

    applySkip({ fire, reminder, clicker: "U_A", now: MEETING });

    assert.deepEqual(pendingLap(listHosts(reminder.id)), ["U_B", "U_A"]);
  });

  it("leaves nobody hosting when everyone left in the lap has skipped", () => {
    const [fire, reminder] = fired(["U_A", "U_B", "U_C"], ["U_A", "U_B", "U_C"]);
    applySkip({ fire, reminder, clicker: "U_B", now: MEETING });
    applySkip({ fire, reminder, clicker: "U_C", now: MEETING });

    const outcome = applySkip({ fire, reminder, clicker: "U_A", now: MEETING });

    assert.equal(getFireByMessageTs(MESSAGE_TS)?.hostUserId, null);
    assert.match(outcome.handover ?? "", /nobody is hosting/);
  });

  it("still marks the clicker skipping and keeps their turn when nobody can take over", () => {
    const [fire, reminder] = fired(["U_A", "U_B"], ["U_A", "U_B"]);
    applySkip({ fire, reminder, clicker: "U_B", now: MEETING });

    applySkip({ fire, reminder, clicker: "U_A", now: MEETING });

    assert.deepEqual(skipIds(fire.id).sort(), ["U_A", "U_B"]);
    assert.deepEqual(pendingLap(listHosts(reminder.id)), ["U_B", "U_A"]);
  });

  it("refuses when they are the only person on the rotation", () => {
    const [fire, reminder] = fired(["U_A"], ["U_A"]);

    const outcome = applySkip({ fire, reminder, clicker: "U_A", now: MEETING });

    assert.match(outcome.ephemeral ?? "", /only person/);
    assert.equal(getFireByMessageTs(MESSAGE_TS)?.hostUserId, "U_A");
    assert.deepEqual(skipIds(fire.id), []);
  });

  it("records a reason alongside the handover, which the posts then carry", () => {
    const [fire, reminder] = fired(["U_A", "U_B"], ["U_A", "U_B"]);

    const outcome = applySkip({
      fire,
      reminder,
      clicker: "U_A",
      reason: "sick",
      now: MEETING,
    });

    assert.match(outcome.handover ?? "", /<@U_B> is hosting instead/);
    assert.equal(getSkip(fire.id, "U_A")?.reason, "sick");
  });
});

describe("the handover window", () => {
  it("is open right up to 30 minutes after the meeting", () => {
    const [fire, reminder] = fired(["U_A", "U_B"], ["U_A", "U_B"]);

    applySkip({ fire, reminder, clicker: "U_A", now: fromMeeting(29) });

    assert.equal(getFireByMessageTs(MESSAGE_TS)?.hostUserId, "U_B");
  });

  it("is closed after that, changing nothing at all", () => {
    const [fire, reminder] = fired(["U_A", "U_B"], ["U_A", "U_B"]);

    const outcome = applySkip({ fire, reminder, clicker: "U_A", now: fromMeeting(31) });

    assert.match(outcome.ephemeral ?? "", /too late to hand over/);
    assert.equal(getFireByMessageTs(MESSAGE_TS)?.hostUserId, "U_A");
    assert.deepEqual(skipIds(fire.id), []);
    assert.deepEqual(pendingLap(listHosts(reminder.id)), ["U_B"]);
  });

  it("is measured from the meeting, so a lead leaves the whole heads-up period open", () => {
    // Fired 08:05 for a 09:00 meeting. The old fire+30 rule would have shut at 08:35.
    const [fire, reminder] = fired(["U_A", "U_B"], ["U_A", "U_B"], {
      leadMinutes: 55,
      preMessage: "Daily Standup",
    });

    applySkip({ fire, reminder, clicker: "U_A", now: fromMeeting(-50) });

    assert.equal(getFireByMessageTs(MESSAGE_TS)?.hostUserId, "U_B");
  });

  it("never blocks anyone but the host, however long after the meeting", () => {
    const [fire, reminder] = fired(["U_A", "U_B"], ["U_A", "U_B"]);

    const outcome = applySkip({
      fire,
      reminder,
      clicker: "U_B",
      reason: "sick",
      now: fromMeeting(300),
    });

    assert.equal(outcome.ephemeral, undefined);
    assert.deepEqual(skipIds(fire.id), ["U_B"]);
  });
});

describe("either post", () => {
  it("resolves to the same fire, so the button works on both", () => {
    const [fire] = fired(["U_A", "U_B"], ["U_A", "U_B"]);
    setJoinMessageTs(fire.id, JOIN_TS);

    assert.equal(getFireByMessageTs(JOIN_TS)?.id, fire.id);
    assert.equal(getFireByMessageTs(MESSAGE_TS)?.id, fire.id);
  });

  it("hands over identically whichever one was clicked", () => {
    const [fire, reminder] = fired(["U_A", "U_B"], ["U_A", "U_B"]);
    setJoinMessageTs(fire.id, JOIN_TS);

    const fromJoin = getFireByMessageTs(JOIN_TS)!;
    applySkip({ fire: fromJoin, reminder, clicker: "U_A", now: MEETING });

    assert.equal(getFireByMessageTs(MESSAGE_TS)?.hostUserId, "U_B");
  });
});

describe("anyone who is not the host", () => {
  it("marks a roster member skipping without touching the rotation", () => {
    const [fire, reminder] = fired(["U_A", "U_B"], ["U_A", "U_B"]);

    const outcome = applySkip({ fire, reminder, clicker: "U_B", now: MEETING });

    assert.deepEqual(outcome, {});
    assert.deepEqual(skipIds(fire.id), ["U_B"]);
    assert.equal(getFireByMessageTs(MESSAGE_TS)?.hostUserId, "U_A");
    assert.deepEqual(pendingLap(listHosts(reminder.id)), ["U_B"]);
  });

  it("marks someone who is not on the rotation at all", () => {
    const [fire, reminder] = fired(["U_A", "U_B"], ["U_A", "U_B"]);

    applySkip({ fire, reminder, clicker: "U_OUTSIDER", now: MEETING });

    assert.deepEqual(skipIds(fire.id), ["U_OUTSIDER"]);
    assert.equal(listHosts(reminder.id).length, 2);
  });

  it("lists them once however many times they click", () => {
    const [fire, reminder] = fired(["U_A", "U_B"], ["U_A", "U_B"]);
    applySkip({ fire, reminder, clicker: "U_B", now: MEETING });

    applySkip({ fire, reminder, clicker: "U_B", now: MEETING });

    assert.deepEqual(skipIds(fire.id), ["U_B"]);
  });

  it("lets the outgoing host edit their reason on a later click", () => {
    const [fire, reminder] = fired(["U_A", "U_B"], ["U_A", "U_B"]);
    applySkip({ fire, reminder, clicker: "U_A", reason: "sick", now: MEETING });

    const again = applySkip({
      fire: getFireByMessageTs(MESSAGE_TS)!,
      reminder,
      clicker: "U_A",
      reason: "sick, back Thursday",
      now: MEETING,
    });

    assert.equal(again.ephemeral, undefined);
    assert.equal(getSkip(fire.id, "U_A")?.reason, "sick, back Thursday");
    assert.deepEqual(skipIds(fire.id), ["U_A"]);
  });
});

describe("the reason", () => {
  it("is stored, so a reopened dialog and both posts can show it", () => {
    const [fire, reminder] = fired(["U_A", "U_B"], ["U_A", "U_B"]);

    applySkip({ fire, reminder, clicker: "U_B", reason: "sick", now: MEETING });

    assert.equal(getSkip(fire.id, "U_B")?.reason, "sick");
    assert.deepEqual(skipRows(fire.id), [{ userId: "U_B", reason: "sick" }]);
  });

  it("is null when the box was left empty, leaving the person still listed", () => {
    const [fire, reminder] = fired(["U_A", "U_B"], ["U_A", "U_B"]);

    applySkip({ fire, reminder, clicker: "U_B", now: MEETING });

    assert.deepEqual(skipRows(fire.id), [{ userId: "U_B", reason: null }]);
  });

  it("is rewritten in place rather than added twice", () => {
    const [fire, reminder] = fired(["U_A", "U_B"], ["U_A", "U_B"]);
    applySkip({ fire, reminder, clicker: "U_B", reason: "sick", now: MEETING });

    applySkip({ fire, reminder, clicker: "U_B", reason: "on leave", now: MEETING });

    assert.deepEqual(skipRows(fire.id), [{ userId: "U_B", reason: "on leave" }]);
  });

  it("is cleared without dropping the skip itself", () => {
    const [fire, reminder] = fired(["U_A", "U_B"], ["U_A", "U_B"]);
    applySkip({ fire, reminder, clicker: "U_B", reason: "sick", now: MEETING });

    applySkip({ fire, reminder, clicker: "U_B", now: MEETING });

    assert.equal(getSkip(fire.id, "U_B")?.reason, null);
    assert.deepEqual(skipIds(fire.id), ["U_B"]);
  });

  it("is stored exactly as typed, with escaping left to the block that renders it", () => {
    const [fire, reminder] = fired(["U_A", "U_B"], ["U_A", "U_B"]);

    applySkip({ fire, reminder, clicker: "U_B", reason: "<!channel> & co", now: MEETING });

    assert.equal(getSkip(fire.id, "U_B")?.reason, "<!channel> & co");
  });
});
