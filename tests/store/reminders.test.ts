import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { pendingLap } from "../../src/domain/rotation.js";
import { newReminder, useTempDatabase } from "../helpers/store.js";

useTempDatabase();

const { initDb, stmt } = await import("../../src/store/database.js");
const {
  addSkip,
  clearHosts,
  deleteHoliday,
  deleteReminder,
  getFireByMessageTs,
  getHoliday,
  getReminder,
  getReminderById,
  insertHoliday,
  insertReminder,
  lastHostedOn,
  listAllReminders,
  listHolidayDates,
  listHolidays,
  listHosts,
  listReminders,
  listSkips,
  recordFire,
  replaceHosts,
  setFireHost,
  setLap,
  setReminderMessage,
} = await import("../../src/store/reminders.js");

initDb();

/** node:sqlite hands back null-prototype rows, which deepEqual won't match to a literal. */
const plain = <T extends object>(row: T): T => ({ ...row });

beforeEach(() => {
  stmt("DELETE FROM reminders").run();
  stmt("DELETE FROM holidays").run();
});

function seed(overrides = {}): number {
  const reminder = newReminder(overrides);
  insertReminder(reminder);
  return getReminder(reminder.channelId, reminder.code)!.id;
}

describe("reminders", () => {
  it("round-trips every column", () => {
    insertReminder(newReminder({ bodyFormat: "mrkdwn", days: "monday", everyNWeeks: 2 }));

    const stored = getReminder("C1", "standup")!;
    assert.equal(stored.message, "Standup time!");
    assert.equal(stored.bodyFormat, "mrkdwn");
    assert.equal(stored.days, "monday");
    assert.equal(stored.everyNWeeks, 2);
    assert.equal(stored.lastFiredAt, null);
  });

  it("scopes codes to a channel, so the same code can exist in two", () => {
    seed({ channelId: "C1" });
    seed({ channelId: "C2" });

    assert.equal(listReminders("C1").length, 1);
    assert.equal(getReminder("C2", "standup")?.channelId, "C2");
  });

  it("finds a reminder by id, which is all a skip button knows", () => {
    const id = seed();
    assert.equal(getReminderById(id)?.code, "standup");
    assert.equal(getReminderById(id + 999), undefined);
  });

  it("gives the scheduler every channel's reminders, not just one", () => {
    seed({ channelId: "C1", code: "standup" });
    seed({ channelId: "C2", code: "retro" });

    assert.deepEqual(
      listAllReminders().map((reminder) => reminder.code),
      ["standup", "retro"],
    );
  });

  it("resets body_format when the message is edited, since `edit` supplies Markdown", () => {
    seed({ bodyFormat: "mrkdwn" });
    setReminderMessage("C1", "standup", "new text");

    assert.equal(getReminder("C1", "standup")?.bodyFormat, "markdown");
  });

  it("cascades hosts and fires when a reminder is removed", () => {
    const id = seed();
    replaceHosts(id, ["U_A"], ["U_A"]);
    recordFire({
      reminderId: id,
      firedOn: "2026-07-27",
      firedAt: new Date(),
      hostUserId: "U_A",
      messageTs: "111.1",
      nextLap: ["U_A"],
    });

    deleteReminder("C1", "standup");

    assert.equal(listHosts(id).length, 0);
    assert.equal(getFireByMessageTs("111.1"), undefined);
  });
});

describe("host rosters", () => {
  it("returns those who have hosted first, then the pending lap in order", () => {
    const id = seed();
    replaceHosts(id, ["U_A", "U_B", "U_C"], ["U_C", "U_B"]);

    assert.deepEqual(listHosts(id).map(plain), [
      { userId: "U_A", lapOrder: null },
      { userId: "U_C", lapOrder: 0 },
      { userId: "U_B", lapOrder: 1 },
    ]);
  });

  it("keeps the pending lap in order once the hosted members are filtered out", () => {
    const id = seed();
    replaceHosts(id, ["U_A", "U_B", "U_C"], ["U_C", "U_B"]);

    assert.deepEqual(pendingLap(listHosts(id)), ["U_C", "U_B"]);
  });

  it("marks anyone absent from the lap as having already hosted it", () => {
    const id = seed();
    replaceHosts(id, ["U_A", "U_B"], ["U_B"]);

    const hosted = listHosts(id).filter((member) => member.lapOrder === null);
    assert.deepEqual(
      hosted.map((member) => member.userId),
      ["U_A"],
    );
  });

  it("rewrites the whole lap, clearing anyone left out of the new order", () => {
    const id = seed();
    replaceHosts(id, ["U_A", "U_B", "U_C"], ["U_A", "U_B", "U_C"]);

    setLap(id, ["U_C"]);

    assert.deepEqual(listHosts(id).map(plain), [
      { userId: "U_A", lapOrder: null },
      { userId: "U_B", lapOrder: null },
      { userId: "U_C", lapOrder: 0 },
    ]);
  });

  it("drops the whole roster on clear", () => {
    const id = seed();
    replaceHosts(id, ["U_A"], ["U_A"]);
    clearHosts(id);

    assert.deepEqual(listHosts(id).map(plain), []);
  });
});

describe("recordFire", () => {
  it("stamps the reminder, writes the history row and installs the next lap together", () => {
    const id = seed();
    replaceHosts(id, ["U_A", "U_B"], ["U_A", "U_B"]);
    const firedAt = new Date("2026-07-27T02:00:00.000Z");

    recordFire({
      reminderId: id,
      firedOn: "2026-07-27",
      firedAt,
      hostUserId: "U_A",
      messageTs: "222.2",
      nextLap: ["U_B"],
    });

    assert.equal(getReminderById(id)?.lastFiredAt, firedAt.toISOString());

    const fire = getFireByMessageTs("222.2")!;
    assert.equal(fire.hostUserId, "U_A");
    assert.equal(fire.firedOn, "2026-07-27");
    assert.equal(fire.firedAt, firedAt.toISOString());

    assert.deepEqual(listHosts(id).map(plain), [
      { userId: "U_A", lapOrder: null },
      { userId: "U_B", lapOrder: 0 },
    ]);
  });

  it("reports the most recent hosting date per person", () => {
    const id = seed();
    replaceHosts(id, ["U_A"], ["U_A"]);

    for (const firedOn of ["2026-07-06", "2026-07-20", "2026-07-13"]) {
      recordFire({
        reminderId: id,
        firedOn,
        firedAt: new Date(`${firedOn}T02:00:00.000Z`),
        hostUserId: "U_A",
        messageTs: `ts-${firedOn}`,
        nextLap: ["U_A"],
      });
    }

    assert.equal(lastHostedOn(id).get("U_A"), "2026-07-20");
  });

  it("records who actually hosted after a handover replaces them", () => {
    const id = seed();
    recordFire({
      reminderId: id,
      firedOn: "2026-07-27",
      firedAt: new Date(),
      hostUserId: "U_A",
      messageTs: "333.3",
      nextLap: [],
    });

    const fire = getFireByMessageTs("333.3")!;
    setFireHost(fire.id, "U_B");

    assert.equal(getFireByMessageTs("333.3")?.hostUserId, "U_B");
  });
});

describe("skips", () => {
  function fireWithSkips(): number {
    const id = seed();
    recordFire({
      reminderId: id,
      firedOn: "2026-07-27",
      firedAt: new Date(),
      hostUserId: null,
      messageTs: "444.4",
      nextLap: [],
    });
    return getFireByMessageTs("444.4")!.id;
  }

  it("reports false when someone is already down as out", () => {
    const fireId = fireWithSkips();

    assert.equal(addSkip(fireId, "U_A"), true);
    assert.equal(addSkip(fireId, "U_A"), false);
    assert.deepEqual(listSkips(fireId), ["U_A"]);
  });

  it("orders by when someone marked themselves out", () => {
    const fireId = fireWithSkips();
    stmt("INSERT INTO reminder_skips (fire_id, user_id, created_at) VALUES (?, ?, ?)").run(
      fireId,
      "U_B",
      "2026-07-27T09:05:00.000Z",
    );
    stmt("INSERT INTO reminder_skips (fire_id, user_id, created_at) VALUES (?, ?, ?)").run(
      fireId,
      "U_A",
      "2026-07-27T09:10:00.000Z",
    );

    assert.deepEqual(listSkips(fireId), ["U_B", "U_A"]);
  });

  it("breaks a same-instant tie on user id, so the list never reshuffles itself", () => {
    const fireId = fireWithSkips();
    // Written directly: two addSkip calls only collide when they land in the
    // same millisecond, which makes the tie itself untestable through them.
    const sameInstant = "2026-07-27T09:00:00.000Z";
    for (const userId of ["U_B", "U_A"]) {
      stmt("INSERT INTO reminder_skips (fire_id, user_id, created_at) VALUES (?, ?, ?)").run(
        fireId,
        userId,
        sameInstant,
      );
    }

    assert.deepEqual(listSkips(fireId), ["U_A", "U_B"]);
  });
});

describe("holidays", () => {
  it("round-trips and lists in date order", () => {
    insertHoliday({ date: "2026-08-17", addedBy: "U_A", addedInChannel: "C1" });
    insertHoliday({ date: "2026-01-01", addedBy: "U_B", addedInChannel: "C2" });

    assert.deepEqual(
      listHolidays().map((holiday) => holiday.date),
      ["2026-01-01", "2026-08-17"],
    );
    assert.equal(getHoliday("2026-08-17")?.addedBy, "U_A");
    assert.deepEqual([...listHolidayDates()].sort(), ["2026-01-01", "2026-08-17"]);
  });

  it("removes one without touching the others", () => {
    insertHoliday({ date: "2026-08-17", addedBy: "U_A", addedInChannel: "C1" });
    insertHoliday({ date: "2026-01-01", addedBy: "U_A", addedInChannel: "C1" });

    deleteHoliday("2026-08-17");

    assert.equal(getHoliday("2026-08-17"), undefined);
    assert.equal(getHoliday("2026-01-01")?.date, "2026-01-01");
  });
});
