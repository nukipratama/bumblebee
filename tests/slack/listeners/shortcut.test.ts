import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { newReminder, useTempDatabase } from "../../helpers/store.js";

useTempDatabase();

const { initDb, stmt } = await import("../../../src/store/database.js");
const { insertReminder } = await import("../../../src/store/reminders.js");
const { readSubmission, validate } = await import("../../../src/slack/listeners/shortcut.js");

initDb();

beforeEach(() => {
  stmt("DELETE FROM reminders").run();
});

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday"];

const submission = (overrides = {}) => ({
  code: "standup",
  at: "09:15",
  dayNames: WEEKDAYS,
  everyNWeeks: 1,
  hosts: [],
  ...overrides,
});

/** The shape `view.state.values` arrives in, with every block using the action id `value`. */
const values = (fields: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(fields).map(([block, state]) => [block, { value: state }]),
  ) as Parameters<typeof readSubmission>[0];

describe("readSubmission", () => {
  it("reads the typed time out of the text field", () => {
    const read = readSubmission(
      values({
        code: { value: "standup" },
        at: { value: "09:15" },
        days: { selected_options: [{ value: "monday" }] },
        cadence: { selected_option: { value: "2" } },
        hosts: { selected_users: ["U_A"] },
      }),
    );

    assert.equal(read.at, "09:15");
    assert.equal(read.code, "standup");
    assert.deepEqual(read.dayNames, ["monday"]);
    assert.equal(read.everyNWeeks, 2);
    assert.deepEqual(read.hosts, ["U_A"]);
  });

  it("trims what was typed, since a text field keeps stray spaces", () => {
    const read = readSubmission(values({ at: { value: "  09:15 " }, code: { value: " standup " } }));

    assert.equal(read.at, "09:15");
    assert.equal(read.code, "standup");
  });

  it("reads an empty time rather than throwing when the field is missing", () => {
    assert.equal(readSubmission(values({})).at, "");
  });
});

describe("validate — time", () => {
  it("accepts a time on the minute, which the old picker could not offer", () => {
    for (const at of ["09:15", "16:35", "00:01", "23:59"]) {
      const checked = validate(submission({ at }), "C1");
      assert.ok(!("errors" in checked), `expected ${at} to be accepted`);
      assert.equal(checked.at, at);
    }
  });

  it("rejects malformed times against the field, not the dialog", () => {
    for (const at of ["9:00", "25:00", "09:60", "0900", "9am", "", "half nine"]) {
      const checked = validate(submission({ at }), "C1");
      assert.ok("errors" in checked, `expected ${at} to be rejected`);
      assert.match(checked.errors.at ?? "", /24-hour time/);
    }
  });

  it("rejects the same times the --at flag rejects, so both routes agree", () => {
    const checked = validate(submission({ at: "9:00" }), "C1");
    assert.ok("errors" in checked);
    assert.match(checked.errors.at!, /use HH:MM/);
  });
});

describe("validate — everything else still applies", () => {
  it("reports a bad code and a bad time together", () => {
    const checked = validate(submission({ code: "Stand Up", at: "nope" }), "C1");

    assert.ok("errors" in checked);
    assert.ok(checked.errors.code);
    assert.ok(checked.errors.at);
  });

  it("rejects a code already used in the channel", () => {
    insertReminder(newReminder({ code: "standup" }));

    const checked = validate(submission(), "C1");

    assert.ok("errors" in checked);
    assert.match(checked.errors.code!, /already exists/);
  });

  it("rejects an empty day selection", () => {
    const checked = validate(submission({ dayNames: [] }), "C1");

    assert.ok("errors" in checked);
    assert.ok(checked.errors.days);
  });

  it("rejects a multi-day fortnightly reminder, as `--every-2-week` does", () => {
    const checked = validate(submission({ everyNWeeks: 2 }), "C1");

    assert.ok("errors" in checked);
    assert.match(checked.errors.days!, /exactly one day/);
  });

  it("collapses all seven days to the daily marker", () => {
    const everyDay = [...WEEKDAYS, "saturday", "sunday"];
    const checked = validate(submission({ dayNames: everyDay }), "C1");

    assert.ok(!("errors" in checked));
    assert.equal(checked.days, "*");
  });
});
