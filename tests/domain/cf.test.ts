import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SQUADS,
  isSquad,
  squadStatusLine,
  squadsColumn,
  squadsFromColumn,
  statusEmoji,
  statusLabel,
} from "../../src/domain/cf.js";
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
  it("shows a bulleted waiting placeholder when nobody has reported", () => {
    assert.equal(squadStatusLine("LIMO", undefined), "• *LIMO* — _not yet reported_");
  });

  it("shows a bulleted line with the status and who reported it", () => {
    const line = squadStatusLine("LIMO", {
      squad: "LIMO",
      status: "no_mr",
      respondedBy: "U123",
    });
    assert.equal(line, "• *LIMO* — ❌ No MR (<@U123>)");
  });
});

describe("isSquad", () => {
  it("is true for each configured squad", () => {
    for (const squad of SQUADS) assert.equal(isSquad(squad), true);
  });

  it("is false for an unknown value", () => {
    assert.equal(isSquad("Growth"), false);
  });
});

describe("squadsColumn", () => {
  it("collapses an empty selection to null", () => {
    assert.equal(squadsColumn([]), null);
  });

  it("collapses a full selection to null", () => {
    assert.equal(squadsColumn(SQUADS), null);
  });

  it("comma-joins a subset in canonical SQUADS order regardless of insertion order", () => {
    assert.equal(squadsColumn(["Core BE", "SS"]), "SS,Core BE");
  });
});

describe("squadsFromColumn", () => {
  it("resolves null to all squads", () => {
    assert.deepEqual(squadsFromColumn(null), SQUADS);
  });

  it("resolves an empty string to all squads", () => {
    assert.deepEqual(squadsFromColumn(""), SQUADS);
  });

  it("parses a comma-joined subset", () => {
    assert.deepEqual(squadsFromColumn("SS,Core FE"), ["SS", "Core FE"]);
  });

  it("drops an unrecognized token", () => {
    assert.deepEqual(squadsFromColumn("SS,Growth"), ["SS"]);
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
