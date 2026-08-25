import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { App } from "@slack/bolt";
import { localParts, type WallClock } from "../../src/domain/clock.js";
import { fakeClient, newReminder, recordingLogger, useTempDatabase } from "../helpers/store.js";

useTempDatabase();

const { initDb, stmt } = await import("../../src/store/database.js");
const { getReminder, insertReminder } = await import("../../src/store/reminders.js");
const { setSchedule, getSchedule, replaceRepos } = await import("../../src/store/cf.js");
const { assertJakarta, duePost, getLastTickAt, runCfTick, runTick } = await import(
  "../../src/app/scheduler.js"
);

initDb();

beforeEach(() => {
  // Children before parents: cf_messages/cf_rounds reference cf_repos without cascading.
  for (const table of ["reminders", "cf_schedule", "cf_messages", "cf_rounds", "cf_repos"]) {
    stmt(`DELETE FROM ${table}`).run();
  }
});

function fakeApp(client: unknown, logger = recordingLogger()): App & { logger: ReturnType<typeof recordingLogger> } {
  return { client, logger } as unknown as App & { logger: ReturnType<typeof recordingLogger> };
}

describe("assertJakarta", () => {
  it("logs nothing when the process runs in Asia/Jakarta, as the test suite does", () => {
    const logger = recordingLogger();
    assertJakarta(logger);
    assert.equal(logger.calls.length, 0);
  });

  it("logs an error naming the wrong offset when TZ is misconfigured", () => {
    const original = process.env.TZ;
    process.env.TZ = "UTC";
    try {
      const logger = recordingLogger();
      assertJakarta(logger);
      assert.equal(logger.calls.length, 1);
      assert.match(logger.calls[0]!.message, /TZ misconfigured: expected UTC\+7/);
    } finally {
      process.env.TZ = original;
    }
  });
});

const wallClock = (overrides: Partial<WallClock> = {}): WallClock => ({
  time: "09:00",
  day: "monday",
  date: "2026-08-24",
  ...overrides,
});

describe("duePost", () => {
  it("is undefined when neither the lead time nor `at` matches", () => {
    const reminder = { at: "09:00", days: "*", leadMinutes: 0 } as Parameters<typeof duePost>[0];
    assert.equal(duePost(reminder, wallClock({ time: "08:00" })), undefined);
  });

  it("is undefined on a day the reminder doesn't run", () => {
    const reminder = { at: "09:00", days: "monday", leadMinutes: 0 } as Parameters<typeof duePost>[0];
    assert.equal(duePost(reminder, wallClock({ day: "tuesday" })), undefined);
  });

  it("returns a post function when the lead time matches", () => {
    const reminder = { at: "09:00", days: "*", leadMinutes: 15 } as Parameters<typeof duePost>[0];
    assert.equal(typeof duePost(reminder, wallClock({ time: "08:45" })), "function");
  });

  it("returns a post function at `at` regardless of whether a lead is set", () => {
    for (const leadMinutes of [0, 15]) {
      const reminder = { at: "09:00", days: "*", leadMinutes } as Parameters<typeof duePost>[0];
      assert.equal(typeof duePost(reminder, wallClock({ time: "09:00" })), "function");
    }
  });
});

describe("runTick", () => {
  it("fires a reminder due this exact minute and records the tick time", async () => {
    const at = localParts(new Date()).time;
    insertReminder(newReminder({ code: "due", at, days: "*" }));
    const { client, posted } = fakeClient();

    const before = new Date();
    await runTick(fakeApp(client));

    assert.equal(posted.length, 1);
    assert.ok((getLastTickAt() ?? new Date(0)) >= before);
  });

  it("leaves a reminder alone when it isn't due this minute", async () => {
    insertReminder(newReminder({ code: "not-due", at: "23:59", days: "*" }));
    const { client, posted } = fakeClient();

    await runTick(fakeApp(client));

    assert.equal(posted.length, 0);
  });

  it("keeps firing the rest of the reminders when one fails to post", async () => {
    const at = localParts(new Date()).time;
    insertReminder(newReminder({ code: "fails", at, days: "*" }));
    insertReminder(newReminder({ code: "ok", channelId: "C2", at, days: "*" }));
    let calls = 0;
    const { client, posted } = fakeClient(async () => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return { ts: "1.1" };
    });

    await runTick(fakeApp(client, recordingLogger()));

    // fakeClient records every attempt, successful or not — both reminders were
    // still attempted, so the first one throwing didn't abort the loop.
    assert.equal(posted.length, 2, "the second reminder is still attempted after the first one throws");
  });
});

describe("runCfTick", () => {
  it("starts a round for a channel whose schedule matches, and marks it fired", async () => {
    const at = localParts(new Date()).time;
    setSchedule("C1", at, "*");
    replaceRepos("C1", ["pms"]);
    const { client, posted } = fakeClient();
    const today = localParts(new Date()).date;

    await runCfTick(fakeApp(client), { time: at, day: "monday", date: today });

    assert.equal(posted.length, 1);
    assert.equal(getSchedule("C1")?.lastFiredDate, today);
  });

  it("does nothing for a channel whose schedule doesn't match this minute", async () => {
    setSchedule("C1", "23:59", "*");
    const { client, posted } = fakeClient();

    await runCfTick(fakeApp(client), wallClock());

    assert.equal(posted.length, 0);
    assert.equal(getSchedule("C1")?.lastFiredDate, null);
  });
});
