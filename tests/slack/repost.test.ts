import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { NewReminder } from "../../src/domain/types.js";
import { fakeClient, newReminder, useTempDatabase } from "../helpers/store.js";

useTempDatabase();

const { initDb, stmt } = await import("../../src/store/database.js");
const { getFireByMessageTs, insertReminder, getReminder, recordFire, replaceHosts, setJoinMessageTs } =
  await import("../../src/store/reminders.js");
const { postsOf, repost } = await import("../../src/slack/repost.js");

initDb();

const MESSAGE_TS = "1700000000.0001";
const JOIN_TS = "1700000000.0002";
const FIRED_ON = "2026-07-27";

beforeEach(() => {
  stmt("DELETE FROM reminders").run();
});

function fired(overrides: Partial<NewReminder> = {}) {
  const reminder = newReminder(overrides);
  insertReminder(reminder);
  const stored = getReminder(reminder.channelId, reminder.code)!;
  replaceHosts(stored.id, ["U_A", "U_B"], ["U_A", "U_B"]);
  recordFire({
    reminderId: stored.id,
    firedOn: FIRED_ON,
    firedAt: new Date(`${FIRED_ON}T09:00:00`),
    hostUserId: "U_A",
    messageTs: MESSAGE_TS,
    nextLap: ["U_B"],
  });
  return { reminder: stored, fire: getFireByMessageTs(MESSAGE_TS)! };
}

describe("postsOf", () => {
  it("is just the heads-up post before the meeting posts, tagged as heads-up when there's a lead", () => {
    const { reminder, fire } = fired({ leadMinutes: 15, preMessage: "Standup soon" });

    assert.deepEqual(postsOf(fire, reminder), [{ ts: MESSAGE_TS, which: "heads-up" }]);
  });

  it("tags the single post as the meeting when there is no lead", () => {
    const { reminder, fire } = fired();

    assert.deepEqual(postsOf(fire, reminder), [{ ts: MESSAGE_TS, which: "meeting" }]);
  });

  it("includes both posts once the meeting post has gone out too", () => {
    const { reminder, fire } = fired({ leadMinutes: 15, preMessage: "Standup soon" });
    setJoinMessageTs(fire.id, JOIN_TS);
    const current = getFireByMessageTs(MESSAGE_TS)!;

    assert.deepEqual(postsOf(current, reminder), [
      { ts: MESSAGE_TS, which: "heads-up" },
      { ts: JOIN_TS, which: "meeting" },
    ]);
  });
});

describe("repost", () => {
  it("updates every post that exists for the fire", async () => {
    const { reminder, fire } = fired({ leadMinutes: 15, preMessage: "Standup soon" });
    setJoinMessageTs(fire.id, JOIN_TS);
    const current = getFireByMessageTs(MESSAGE_TS)!;
    const { client, updated } = fakeClient();

    await repost(client, current, reminder, "C1");

    assert.deepEqual(
      updated.map((u) => u.ts),
      [MESSAGE_TS, JOIN_TS],
    );
    assert.ok(updated.every((u) => u.channel === "C1"));
  });

  it("updates just the one post when only the meeting has fired", async () => {
    const { reminder, fire } = fired();
    const { client, updated } = fakeClient();

    await repost(client, fire, reminder, "C1");

    assert.deepEqual(
      updated.map((u) => u.ts),
      [MESSAGE_TS],
    );
  });
});
