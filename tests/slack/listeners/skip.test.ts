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
  getSkip,
  insertReminder,
  listHosts,
  listSkips,
  recordFire,
  replaceHosts,
  setSkipNoticeTs,
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

/** The listener stamps this after posting, so a test that edits has to stand in for it. */
function withNotice(fire: Fire, userId: string, ts: string): void {
  setSkipNoticeTs(fire.id, userId, ts);
}

describe("the host hands over", () => {
  it("names the next person in the lap as the host of this occurrence", () => {
    const [fire, reminder] = fired(["U_A", "U_B", "U_C"], ["U_A", "U_B", "U_C"]);

    const outcome = applySkip({ fire, reminder, clicker: "U_A", now: Date.now() });

    assert.equal(getFireByMessageTs(MESSAGE_TS)?.hostUserId, "U_B");
    assert.match(outcome.handover ?? "", /<@U_B> is hosting instead/);
  });

  it("marks the outgoing host as skipping", () => {
    const [fire, reminder] = fired(["U_A", "U_B"], ["U_A", "U_B"]);

    applySkip({ fire, reminder, clicker: "U_A", now: Date.now() });

    assert.deepEqual(listSkips(fire.id), ["U_A"]);
  });

  it("keeps their turn by sending them to the back of the lap", () => {
    const [fire, reminder] = fired(["U_A", "U_B", "U_C"], ["U_A", "U_B", "U_C"]);

    applySkip({ fire, reminder, clicker: "U_A", now: Date.now() });

    assert.deepEqual(pendingLap(listHosts(reminder.id)), ["U_C", "U_A"]);
  });

  it("draws a fresh lap that avoids them when this fire closed the lap", () => {
    const [fire, reminder] = fired(["U_A", "U_B", "U_C"], ["U_A"]);

    applySkip({ fire, reminder, clicker: "U_A", now: Date.now() });

    const replacement = getFireByMessageTs(MESSAGE_TS)!.hostUserId;
    assert.notEqual(replacement, "U_A");
    assert.ok(["U_B", "U_C"].includes(replacement!));
  });

  it("passes over someone who is already down as skipping", () => {
    const [fire, reminder] = fired(["U_A", "U_B", "U_C"], ["U_A", "U_B", "U_C"]);
    applySkip({ fire, reminder, clicker: "U_B", now: Date.now() });

    applySkip({ fire, reminder, clicker: "U_A", now: Date.now() });

    assert.equal(getFireByMessageTs(MESSAGE_TS)?.hostUserId, "U_C");
  });

  it("leaves whoever was passed over in place, since skipping costs no turn", () => {
    const [fire, reminder] = fired(["U_A", "U_B", "U_C"], ["U_A", "U_B", "U_C"]);
    applySkip({ fire, reminder, clicker: "U_B", now: Date.now() });

    applySkip({ fire, reminder, clicker: "U_A", now: Date.now() });

    assert.deepEqual(pendingLap(listHosts(reminder.id)), ["U_B", "U_A"]);
  });

  it("leaves nobody hosting when everyone left in the lap has skipped", () => {
    const [fire, reminder] = fired(["U_A", "U_B", "U_C"], ["U_A", "U_B", "U_C"]);
    applySkip({ fire, reminder, clicker: "U_B", now: Date.now() });
    applySkip({ fire, reminder, clicker: "U_C", now: Date.now() });

    const outcome = applySkip({ fire, reminder, clicker: "U_A", now: Date.now() });

    assert.equal(getFireByMessageTs(MESSAGE_TS)?.hostUserId, null);
    assert.match(outcome.handover ?? "", /nobody is hosting/);
  });

  it("still marks the clicker skipping and keeps their turn when nobody can take over", () => {
    const [fire, reminder] = fired(["U_A", "U_B"], ["U_A", "U_B"]);
    applySkip({ fire, reminder, clicker: "U_B", now: Date.now() });

    applySkip({ fire, reminder, clicker: "U_A", now: Date.now() });

    assert.deepEqual(listSkips(fire.id).sort(), ["U_A", "U_B"]);
    assert.deepEqual(pendingLap(listHosts(reminder.id)), ["U_B", "U_A"]);
  });

  it("refuses when they are the only person on the rotation", () => {
    const [fire, reminder] = fired(["U_A"], ["U_A"]);

    const outcome = applySkip({ fire, reminder, clicker: "U_A", now: Date.now() });

    assert.match(outcome.ephemeral ?? "", /only person/);
    assert.equal(getFireByMessageTs(MESSAGE_TS)?.hostUserId, "U_A");
    assert.deepEqual(listSkips(fire.id), []);
  });

  it("carries a reason alongside the handover, as two separate replies", () => {
    const [fire, reminder] = fired(["U_A", "U_B"], ["U_A", "U_B"]);

    const outcome = applySkip({
      fire,
      reminder,
      clicker: "U_A",
      reason: "sick",
      now: Date.now(),
    });

    assert.match(outcome.handover ?? "", /<@U_B> is hosting instead/);
    assert.deepEqual(outcome.notice, { kind: "post", text: "🔕 <@U_A> is skipping — sick" });
  });

  it("hands over with no notice at all when no reason was given", () => {
    const [fire, reminder] = fired(["U_A", "U_B"], ["U_A", "U_B"]);

    const outcome = applySkip({ fire, reminder, clicker: "U_A", now: Date.now() });

    assert.equal(outcome.notice, undefined);
  });
});

describe("the handover window", () => {
  it("is open within 30 minutes of the fire", () => {
    const [fire, reminder] = fired(["U_A", "U_B"], ["U_A", "U_B"], 29);

    applySkip({ fire, reminder, clicker: "U_A", now: Date.now() });

    assert.equal(getFireByMessageTs(MESSAGE_TS)?.hostUserId, "U_B");
  });

  it("is closed after 30 minutes, changing nothing at all", () => {
    const [fire, reminder] = fired(["U_A", "U_B"], ["U_A", "U_B"], 31);

    const outcome = applySkip({ fire, reminder, clicker: "U_A", now: Date.now() });

    assert.match(outcome.ephemeral ?? "", /too late to hand over/);
    assert.equal(getFireByMessageTs(MESSAGE_TS)?.hostUserId, "U_A");
    assert.deepEqual(listSkips(fire.id), []);
    assert.deepEqual(pendingLap(listHosts(reminder.id)), ["U_B"]);
  });

  it("never blocks anyone but the host, however long ago the fire was", () => {
    const [fire, reminder] = fired(["U_A", "U_B"], ["U_A", "U_B"], 300);

    const outcome = applySkip({ fire, reminder, clicker: "U_B", reason: "sick", now: Date.now() });

    assert.equal(outcome.ephemeral, undefined);
    assert.deepEqual(listSkips(fire.id), ["U_B"]);
  });

  it("treats a fire predating the fired_at column as too old to hand over", () => {
    const [fire, reminder] = fired(["U_A", "U_B"], ["U_A", "U_B"]);
    stmt("UPDATE reminder_fires SET fired_at = NULL WHERE id = ?").run(fire.id);
    const legacy = getFireByMessageTs(MESSAGE_TS)!;

    const outcome = applySkip({ fire: legacy, reminder, clicker: "U_A", now: Date.now() });

    assert.match(outcome.ephemeral ?? "", /too late to hand over/);
    assert.equal(getFireByMessageTs(MESSAGE_TS)?.hostUserId, "U_A");
  });
});

describe("anyone who is not the host", () => {
  it("marks a roster member skipping without touching the rotation", () => {
    const [fire, reminder] = fired(["U_A", "U_B"], ["U_A", "U_B"]);

    const outcome = applySkip({ fire, reminder, clicker: "U_B", now: Date.now() });

    assert.deepEqual(outcome, { notice: undefined });
    assert.deepEqual(listSkips(fire.id), ["U_B"]);
    assert.equal(getFireByMessageTs(MESSAGE_TS)?.hostUserId, "U_A");
    assert.deepEqual(pendingLap(listHosts(reminder.id)), ["U_B"]);
  });

  it("marks someone who is not on the rotation at all", () => {
    const [fire, reminder] = fired(["U_A", "U_B"], ["U_A", "U_B"]);

    applySkip({ fire, reminder, clicker: "U_OUTSIDER", now: Date.now() });

    assert.deepEqual(listSkips(fire.id), ["U_OUTSIDER"]);
    assert.equal(listHosts(reminder.id).length, 2);
  });

  it("lists them once however many times they click", () => {
    const [fire, reminder] = fired(["U_A", "U_B"], ["U_A", "U_B"]);
    applySkip({ fire, reminder, clicker: "U_B", now: Date.now() });

    applySkip({ fire, reminder, clicker: "U_B", now: Date.now() });

    assert.deepEqual(listSkips(fire.id), ["U_B"]);
  });

  it("lets the outgoing host edit their reason on a later click", () => {
    const [fire, reminder] = fired(["U_A", "U_B"], ["U_A", "U_B"]);
    applySkip({ fire, reminder, clicker: "U_A", reason: "sick", now: Date.now() });
    withNotice(fire, "U_A", "1700000001.0002");

    const again = applySkip({
      fire: getFireByMessageTs(MESSAGE_TS)!,
      reminder,
      clicker: "U_A",
      reason: "sick, back Thursday",
      now: Date.now(),
    });

    assert.equal(again.ephemeral, undefined);
    assert.deepEqual(again.notice, {
      kind: "update",
      ts: "1700000001.0002",
      text: "🔕 <@U_A> is skipping — sick, back Thursday",
    });
    assert.deepEqual(listSkips(fire.id), ["U_A"]);
  });
});

describe("the reason", () => {
  function skipping(reason?: string): ReturnType<typeof applySkip> {
    const [fire, reminder] = fired(["U_A", "U_B"], ["U_A", "U_B"]);
    return applySkip({ fire, reminder, clicker: "U_B", reason, now: Date.now() });
  }

  it("is posted in the thread the first time it is given", () => {
    assert.deepEqual(skipping("sick").notice, {
      kind: "post",
      text: "🔕 <@U_B> is skipping — sick",
    });
  });

  it("is stored, so a reopened dialog can prefill it", () => {
    const [fire, reminder] = fired(["U_A", "U_B"], ["U_A", "U_B"]);

    applySkip({ fire, reminder, clicker: "U_B", reason: "sick", now: Date.now() });

    assert.equal(getSkip(fire.id, "U_B")?.reason, "sick");
  });

  it("says nothing when the box was left empty", () => {
    assert.equal(skipping().notice, undefined);
  });

  it("rewrites its own reply rather than adding a second one", () => {
    const [fire, reminder] = fired(["U_A", "U_B"], ["U_A", "U_B"]);
    applySkip({ fire, reminder, clicker: "U_B", reason: "sick", now: Date.now() });
    withNotice(fire, "U_B", "1700000001.0002");

    const outcome = applySkip({
      fire,
      reminder,
      clicker: "U_B",
      reason: "on leave",
      now: Date.now(),
    });

    assert.deepEqual(outcome.notice, {
      kind: "update",
      ts: "1700000001.0002",
      text: "🔕 <@U_B> is skipping — on leave",
    });
  });

  it("says nothing at all when resubmitted unchanged", () => {
    const [fire, reminder] = fired(["U_A", "U_B"], ["U_A", "U_B"]);
    applySkip({ fire, reminder, clicker: "U_B", reason: "sick", now: Date.now() });
    withNotice(fire, "U_B", "1700000001.0002");

    const outcome = applySkip({ fire, reminder, clicker: "U_B", reason: "sick", now: Date.now() });

    assert.equal(outcome.notice, undefined);
  });

  it("deletes its reply when cleared, leaving the person still listed", () => {
    const [fire, reminder] = fired(["U_A", "U_B"], ["U_A", "U_B"]);
    applySkip({ fire, reminder, clicker: "U_B", reason: "sick", now: Date.now() });
    withNotice(fire, "U_B", "1700000001.0002");

    const outcome = applySkip({ fire, reminder, clicker: "U_B", now: Date.now() });

    assert.deepEqual(outcome.notice, { kind: "delete", ts: "1700000001.0002" });
    assert.equal(getSkip(fire.id, "U_B")?.reason, null);
    assert.deepEqual(listSkips(fire.id), ["U_B"]);
  });

  it("is escaped, so a typed <!channel> cannot ping the channel", () => {
    assert.deepEqual(skipping("<!channel> & <@U_X>").notice, {
      kind: "post",
      text: "🔕 <@U_B> is skipping — &lt;!channel&gt; &amp; &lt;@U_X&gt;",
    });
  });
});
