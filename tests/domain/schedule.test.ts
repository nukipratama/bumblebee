import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cadenceOk,
  leadFitsBeforeMidnight,
  leadTime,
  matches,
  matchesLead,
  nextCfFire,
  nextFire,
} from "../../src/domain/schedule.js";
import type { Reminder } from "../../src/domain/types.js";

const MONDAY = "2026-07-27T09:00:00";
const never = () => false;
const always = () => true;

function reminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    id: 1,
    channelId: "C1",
    code: "standup",
    at: "09:00",
    days: "monday,tuesday,wednesday,thursday,friday",
    message: "Standup time",
    bodyFormat: "markdown",
    everyNWeeks: 1,
    leadMinutes: 0,
    preMessage: null,
    lastFiredAt: null,
    createdBy: "U1",
    createdAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("matches", () => {
  it("matches on the exact minute of a listed day", () => {
    assert.equal(matches(reminder(), { time: "09:00", day: "monday" }), true);
  });

  it("does not match a minute early or late", () => {
    assert.equal(matches(reminder(), { time: "08:59", day: "monday" }), false);
    assert.equal(matches(reminder(), { time: "09:01", day: "monday" }), false);
  });

  it("does not match a day outside --on", () => {
    assert.equal(matches(reminder(), { time: "09:00", day: "sunday" }), false);
  });

  it("matches any day when days is *", () => {
    assert.equal(matches(reminder({ days: "*" }), { time: "09:00", day: "sunday" }), true);
  });
});

describe("cadenceOk", () => {
  it("is always true for every-1-week", () => {
    const weekly = reminder({ everyNWeeks: 1, lastFiredAt: "2026-07-26T02:00:00.000Z" });
    assert.equal(cadenceOk(weekly, "2026-07-27"), true);
  });

  it("is true when a reminder has never fired", () => {
    assert.equal(cadenceOk(reminder({ everyNWeeks: 2 }), "2026-07-27"), true);
  });

  it("requires 13 days for every-2-week", () => {
    const fortnightly = (lastFiredAt: string) => reminder({ everyNWeeks: 2, lastFiredAt });

    assert.equal(cadenceOk(fortnightly("2026-07-20T02:00:00.000Z"), "2026-07-27"), false);
    assert.equal(cadenceOk(fortnightly("2026-07-14T02:00:00.000Z"), "2026-07-27"), true);
    assert.equal(cadenceOk(fortnightly("2026-07-13T02:00:00.000Z"), "2026-07-27"), true);
  });

  it("requires 20 days for every-3-week", () => {
    const triweekly = (lastFiredAt: string) => reminder({ everyNWeeks: 3, lastFiredAt });

    assert.equal(cadenceOk(triweekly("2026-07-13T02:00:00.000Z"), "2026-07-27"), false);
    assert.equal(cadenceOk(triweekly("2026-07-06T02:00:00.000Z"), "2026-07-27"), true);
  });
});

describe("nextFire", () => {
  it("returns today when the time is still ahead", () => {
    const next = nextFire(reminder(), new Date("2026-07-27T08:00:00"), never);
    assert.deepEqual(next, new Date(MONDAY));
  });

  it("skips to tomorrow once today's time has passed", () => {
    const next = nextFire(reminder(), new Date("2026-07-27T09:30:00"), never);
    assert.deepEqual(next, new Date("2026-07-28T09:00:00"));
  });

  it("skips days not listed in --on", () => {
    const next = nextFire(reminder(), new Date("2026-07-31T10:00:00"), never);
    assert.deepEqual(next, new Date("2026-08-03T09:00:00"));
  });

  it("skips holidays", () => {
    const isHoliday = (date: string) => date === "2026-07-28";
    const next = nextFire(reminder(), new Date("2026-07-27T09:30:00"), isHoliday);
    assert.deepEqual(next, new Date("2026-07-29T09:00:00"));
  });

  it("skips a cadence-blocked week", () => {
    const fortnightly = reminder({
      days: "monday",
      everyNWeeks: 2,
      lastFiredAt: "2026-07-27T02:00:00.000Z",
    });
    const next = nextFire(fortnightly, new Date("2026-07-27T09:30:00"), never);
    assert.deepEqual(next, new Date("2026-08-10T09:00:00"));
  });

  it("returns null when nothing survives the search window", () => {
    assert.equal(nextFire(reminder(), new Date(MONDAY), always), null);
  });
});

describe("nextCfFire", () => {
  const schedule = { at: "09:00", days: "monday,wednesday,friday" };

  it("returns today when the time is still ahead", () => {
    const next = nextCfFire(schedule, new Date("2026-07-27T08:00:00"));
    assert.deepEqual(next, new Date(MONDAY));
  });

  it("skips to the next listed day once today's time has passed", () => {
    const next = nextCfFire(schedule, new Date("2026-07-27T09:30:00"));
    assert.deepEqual(next, new Date("2026-07-29T09:00:00"));
  });

  it("does not check holidays or cadence", () => {
    const next = nextCfFire({ at: "09:00", days: "monday" }, new Date("2026-07-27T09:30:00"));
    assert.deepEqual(next, new Date("2026-08-03T09:00:00"));
  });
});

describe("leadTime", () => {
  it("is null without a lead, which is what every reminder had before", () => {
    assert.equal(leadTime(reminder()), null);
  });

  it("counts back from the meeting time", () => {
    assert.equal(leadTime(reminder({ at: "10:25", leadMinutes: 55 })), "09:30");
  });

  it("crosses the hour correctly", () => {
    assert.equal(leadTime(reminder({ at: "09:05", leadMinutes: 10 })), "08:55");
  });
});

describe("matchesLead", () => {
  const early = reminder({ at: "10:25", leadMinutes: 55 });

  it("matches the lead minute on a listed day", () => {
    assert.equal(matchesLead(early, { time: "09:30", day: "monday" }), true);
  });

  it("ignores the meeting time itself, which the join post handles", () => {
    assert.equal(matchesLead(early, { time: "10:25", day: "monday" }), false);
  });

  it("obeys the same day rule as the meeting post", () => {
    assert.equal(matchesLead(early, { time: "09:30", day: "sunday" }), false);
  });

  it("never matches without a lead, so nothing fires twice", () => {
    const plain = reminder({ at: "10:25" });
    for (const time of ["10:25", "09:30", "00:00"]) {
      assert.equal(matchesLead(plain, { time, day: "monday" }), false);
    }
  });
});

describe("leadFitsBeforeMidnight", () => {
  it("allows a lead that stays inside the day", () => {
    assert.equal(leadFitsBeforeMidnight(55, "10:25").ok, true);
  });

  it("allows one that lands exactly on midnight", () => {
    assert.equal(leadFitsBeforeMidnight(625, "10:25").ok, true);
  });

  it("refuses one that would fire the day before, where the day rule reads wrong", () => {
    const result = leadFitsBeforeMidnight(60, "00:15");
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.error : "", /the day before/);
  });
});
