import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { localParts } from "../../../../src/domain/clock.js";
import type { NewReminder, Reminder } from "../../../../src/domain/types.js";
import { newReminder, useTempDatabase } from "../../../helpers/store.js";

useTempDatabase();

const { initDb, stmt } = await import("../../../../src/store/database.js");
const { addSkip, getFireForDate, getReminder, insertReminder, recordFire, replaceHosts } = await import(
  "../../../../src/store/reminders.js"
);
const { checkHostCurrent } = await import("../../../../src/slack/listeners/remind/hostCurrent.js");

initDb();

const TODAY = localParts(new Date()).date;
const AT = localParts(new Date()).time;
const MINUTES = 60_000;

beforeEach(() => {
  stmt("DELETE FROM reminders").run();
});

function seed(roster: string[], overrides: Partial<NewReminder> = {}): Reminder {
  const reminder = newReminder({ at: AT, ...overrides });
  insertReminder(reminder);
  const stored = getReminder(reminder.channelId, reminder.code)!;
  replaceHosts(stored.id, roster, roster);
  return stored;
}

function fireToday(reminder: Reminder, hostUserId: string | null): void {
  recordFire({
    reminderId: reminder.id,
    firedOn: TODAY,
    firedAt: new Date(),
    hostUserId,
    messageTs: "1700000000.0001",
    nextLap: [],
  });
}

describe("checkHostCurrent", () => {
  it("refuses when nothing has fired today", () => {
    const reminder = seed(["U_A", "U_B"]);

    const result = checkHostCurrent(reminder, "U_B", Date.now());

    assert.deepEqual(result, { error: "`standup` hasn't fired yet today — nothing to set." });
  });

  it("refuses to pick the person already hosting", () => {
    const reminder = seed(["U_A", "U_B"]);
    fireToday(reminder, "U_A");

    const result = checkHostCurrent(reminder, "U_A", Date.now());

    assert.deepEqual(result, { error: "<@U_A> is already hosting `standup`." });
  });

  it("refuses a target who is not on the roster", () => {
    const reminder = seed(["U_A", "U_B"]);
    fireToday(reminder, "U_A");

    const result = checkHostCurrent(reminder, "U_OUTSIDER", Date.now());

    assert.deepEqual(result, { error: "<@U_OUTSIDER> is not on the rotation for `standup`" });
  });

  it("refuses someone who already skipped today", () => {
    const reminder = seed(["U_A", "U_B"]);
    fireToday(reminder, "U_A");
    addSkip(getFireForDate(reminder.id, TODAY)!.id, "U_B", null);

    const result = checkHostCurrent(reminder, "U_B", Date.now());

    assert.deepEqual(result, {
      error: "<@U_B> already skipped `standup` today — pick someone else",
    });
  });

  it("passes with the fire once every check clears", () => {
    const reminder = seed(["U_A", "U_B"]);
    fireToday(reminder, "U_A");

    const result = checkHostCurrent(reminder, "U_B", Date.now());

    assert.equal("fire" in result, true);
    assert.equal("fire" in result && result.fire.hostUserId, "U_A");
  });

  it("is open right up to 30 minutes after the meeting", () => {
    const reminder = seed(["U_A", "U_B"]);
    fireToday(reminder, "U_A");
    const meeting = new Date(`${TODAY}T${AT}:00`).getTime();

    const result = checkHostCurrent(reminder, "U_B", meeting + 30 * MINUTES);

    assert.equal("fire" in result, true);
  });

  it("is closed a minute past that", () => {
    const reminder = seed(["U_A", "U_B"]);
    fireToday(reminder, "U_A");
    const meeting = new Date(`${TODAY}T${AT}:00`).getTime();

    const result = checkHostCurrent(reminder, "U_B", meeting + 31 * MINUTES);

    assert.deepEqual(result, {
      error: "`standup`'s meeting started over 30 minutes ago — the current host can no longer be changed.",
    });
  });
});
