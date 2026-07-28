import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { daysBetween, localParts } from "../../src/domain/clock.js";

describe("localParts", () => {
  it("reads the Jakarta wall clock across a UTC day boundary", () => {
    assert.deepEqual(localParts(new Date("2026-07-25T17:30:00Z")), {
      time: "00:30",
      day: "sunday",
      date: "2026-07-26",
    });
  });

  it("renders midnight as 00:00, never 24:00", () => {
    assert.equal(localParts(new Date("2026-07-25T17:00:00Z")).time, "00:00");
  });

  it("zero-pads single-digit months and days", () => {
    assert.equal(localParts(new Date("2026-01-05T02:00:00Z")).date, "2026-01-05");
  });

  it("names every weekday", () => {
    const monday = new Date("2026-07-27T02:00:00Z");
    assert.equal(localParts(monday).day, "monday");
  });
});

describe("daysBetween", () => {
  it("counts whole calendar days", () => {
    assert.equal(daysBetween("2026-07-13", "2026-07-27"), 14);
  });

  it("counts across a month boundary", () => {
    assert.equal(daysBetween("2026-07-31", "2026-08-01"), 1);
  });

  it("is zero for the same day", () => {
    assert.equal(daysBetween("2026-07-27", "2026-07-27"), 0);
  });
});
