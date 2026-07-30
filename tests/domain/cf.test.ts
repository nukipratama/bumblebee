import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { squadStatusLine, statusEmoji, statusLabel } from "../../src/domain/cf.js";
import { matches } from "../../src/domain/schedule.js";

describe("statusLabel / statusEmoji", () => {
  it("labels all_merged", () => {
    assert.equal(statusLabel("all_merged"), "All Merged");
    assert.equal(statusEmoji("all_merged"), "✅");
  });

  it("labels no_mr", () => {
    assert.equal(statusLabel("no_mr"), "No MR");
    assert.equal(statusEmoji("no_mr"), "❌");
  });
});

describe("squadStatusLine", () => {
  it("shows a waiting placeholder when nobody has reported", () => {
    assert.equal(squadStatusLine("LIMO", undefined), "*LIMO* — _not yet reported_");
  });

  it("shows the status and who reported it", () => {
    const line = squadStatusLine("LIMO", {
      squad: "LIMO",
      status: "no_mr",
      respondedBy: "U123",
    });
    assert.equal(line, "*LIMO* — ❌ No MR (<@U123>)");
  });
});

describe("domain/schedule.ts#matches reused for CfSchedule", () => {
  it("matches a CfSchedule row the same way it matches a Reminder", () => {
    const schedule = { at: "09:00", days: "monday,tuesday,wednesday,thursday,friday" };
    assert.equal(matches(schedule, { time: "09:00", day: "monday" }), true);
    assert.equal(matches(schedule, { time: "09:00", day: "saturday" }), false);
    assert.equal(matches(schedule, { time: "10:00", day: "monday" }), false);
  });
});
