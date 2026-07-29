import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { InputBlock, ModalView } from "@slack/web-api";
import type { Host, Reminder, Skip } from "../../src/domain/types.js";
import {
  SKIP_FORM,
  type FormFields,
  daysFromSelection,
  parseAt,
  plannedEdit,
  readSkipReason,
  readSubmission,
  reminderModal,
  skipModal,
  validate,
} from "../../src/slack/modals.js";

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday"];

const NONE = new Set<string>();

const fields = (overrides: Partial<FormFields> = {}): FormFields => ({
  code: "standup",
  message: "Standup time!",
  at: "09:15",
  dayNames: WEEKDAYS,
  everyNWeeks: 1,
  hosts: [],
  ...overrides,
});

const reminder = (overrides: Partial<Reminder> = {}): Reminder => ({
  id: 1,
  channelId: "C1",
  code: "standup",
  at: "09:15",
  days: "monday,tuesday,wednesday,thursday,friday",
  message: "Standup time!",
  bodyFormat: "markdown",
  everyNWeeks: 1,
  leadMinutes: 0,
  preMessage: null,
  lastFiredAt: null,
  createdBy: "U1",
  createdAt: "2026-07-01T00:00:00.000Z",
  ...overrides,
});

/** The shape `view.state.values` arrives in, with every block using the action id `value`. */
const values = (input: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(input).map(([block, state]) => [block, { value: state }]),
  ) as Parameters<typeof readSubmission>[0];

const blockIds = (mode: Parameters<typeof reminderModal>[0]) =>
  reminderModal(mode).blocks.map((block) => block.block_id);

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

  it("tells a block that was never rendered apart from one left blank", () => {
    const absent = readSubmission(values({ at: { value: "09:15" } }));
    const blank = readSubmission(values({ at: { value: "09:15" }, message: { value: "  " } }));

    assert.equal(absent.message, undefined);
    assert.equal(blank.message, "");
  });

  it("reads an empty roster, which is how a rotation is cleared", () => {
    const cleared = readSubmission(values({ hosts: { selected_users: [] } }));
    assert.deepEqual(cleared.hosts, []);
  });
});

describe("validate — time", () => {
  it("accepts a time on the minute, which the old picker could not offer", () => {
    for (const at of ["09:15", "16:35", "00:01", "23:59"]) {
      const checked = validate(fields({ at }), NONE);
      assert.ok(!("errors" in checked), `expected ${at} to be accepted`);
      assert.equal(checked.at, at);
    }
  });

  it("rejects malformed times against the field, not the dialog", () => {
    for (const at of ["9:00", "25:00", "09:60", "0900", "9am", "", "half nine"]) {
      const checked = validate(fields({ at }), NONE);
      assert.ok("errors" in checked, `expected ${at} to be rejected`);
      assert.match(checked.errors.at ?? "", /24-hour time/);
    }
  });
});

describe("validate — code", () => {
  it("reports a bad code and a bad time together", () => {
    const checked = validate(fields({ code: "Stand Up", at: "nope" }), NONE);

    assert.ok("errors" in checked);
    assert.ok(checked.errors.code);
    assert.ok(checked.errors.at);
  });

  it("rejects a code already used in the channel", () => {
    const checked = validate(fields(), new Set(["standup"]));

    assert.ok("errors" in checked);
    assert.match(checked.errors.code!, /already exists/);
  });

  it("skips the duplicate check when editing, where the name is not on the form", () => {
    const checked = validate(fields({ code: undefined }), new Set(["standup"]));

    assert.ok(!("errors" in checked));
  });
});

describe("validate — message", () => {
  it("rejects a message that is only whitespace", () => {
    const checked = validate(fields({ message: "" }), NONE);

    assert.ok("errors" in checked);
    assert.ok(checked.errors.message);
  });

  it("ignores the message when that block was never rendered", () => {
    const checked = validate(fields({ message: undefined }), NONE);

    assert.ok(!("errors" in checked));
  });
});

describe("validate — days and cadence", () => {
  it("rejects an empty day selection", () => {
    const checked = validate(fields({ dayNames: [] }), NONE);

    assert.ok("errors" in checked);
    assert.ok(checked.errors.days);
  });

  it("rejects a multi-day fortnightly reminder, as the cadence rule does", () => {
    const checked = validate(fields({ everyNWeeks: 2 }), NONE);

    assert.ok("errors" in checked);
    assert.match(checked.errors.days!, /exactly one day/);
  });

  it("collapses all seven days to the daily marker", () => {
    const everyDay = [...WEEKDAYS, "saturday", "sunday"];
    const checked = validate(fields({ dayNames: everyDay }), NONE);

    assert.ok(!("errors" in checked));
    assert.equal(checked.days, "*");
  });
});

describe("reminderModal", () => {
  const source = { kind: "create", channelId: "C1" } as const;

  it("asks for a name when creating and not when editing", () => {
    assert.ok(blockIds({ kind: "create", source }).includes("code"));
    assert.ok(
      !blockIds({
        kind: "edit",
        source: { kind: "edit", channelId: "C1", code: "standup" },
        reminder: reminder(),
        roster: [],
      }).includes("code"),
    );
  });

  it("leaves the message off the form when it comes from a Slack message", () => {
    const ids = blockIds({
      kind: "fromMessage",
      source: { kind: "fromMessage", channelId: "C1", messageTs: "1.1" },
      suggestedCode: "standup",
    });

    assert.ok(!ids.includes("message"));
    assert.ok(ids.includes("code"));
  });

  it("prefills every field from the stored reminder when editing", () => {
    const view = reminderModal({
      kind: "edit",
      source: { kind: "edit", channelId: "C1", code: "standup" },
      reminder: reminder({ at: "16:35", days: "monday", everyNWeeks: 3 }),
      roster: [{ userId: "U_A", lapOrder: 1 }],
    });

    const byId = new Map(view.blocks.map((block) => [block.block_id, block]));
    const element = (id: string) =>
      (byId.get(id) as unknown as { element: Record<string, unknown> }).element;

    assert.equal(element("at").initial_value, "16:35");
    assert.equal(element("message").initial_value, "Standup time!");
    assert.deepEqual(element("hosts").initial_users, ["U_A"]);
    assert.deepEqual(
      (element("days").initial_options as { value: string }[]).map((option) => option.value),
      ["monday"],
    );
    assert.equal(
      (element("cadence").initial_option as { value: string }).value,
      "3",
    );
  });

  it("round-trips the daily marker back to all seven checkboxes", () => {
    const view = reminderModal({
      kind: "edit",
      source: { kind: "edit", channelId: "C1", code: "standup" },
      reminder: reminder({ days: "*" }),
      roster: [],
    });

    const days = view.blocks.find((block) => block.block_id === "days") as {
      element: { initial_options: { value: string }[] };
    };
    assert.equal(days.element.initial_options.length, 7);
  });

  it("warns that retyping a captured body re-saves it as Markdown", () => {
    const view = reminderModal({
      kind: "edit",
      source: { kind: "edit", channelId: "C1", code: "standup" },
      reminder: reminder({ bodyFormat: "mrkdwn" }),
      roster: [],
    });

    const message = view.blocks.find((block) => block.block_id === "message") as {
      hint: { text: string };
    };
    assert.match(message.hint.text, /Markdown/);
  });
});

describe("parseAt", () => {
  it("accepts 24-hour times", () => {
    assert.deepEqual(parseAt("09:00"), { ok: true, value: "09:00" });
    assert.deepEqual(parseAt("23:59"), { ok: true, value: "23:59" });
    assert.deepEqual(parseAt("00:00"), { ok: true, value: "00:00" });
  });

  it("rejects unpadded, out-of-range and malformed times", () => {
    for (const bad of ["9:00", "25:00", "09:60", "0900", "9am"]) {
      const parsed = parseAt(bad);
      assert.equal(parsed.ok, false, `expected ${bad} to be rejected`);
      assert.match(parsed.ok ? "" : parsed.error, /24-hour time/);
    }
  });
});

describe("daysFromSelection", () => {
  const ALL = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

  it("returns a single day", () => {
    assert.deepEqual(daysFromSelection(["monday"]), { ok: true, value: "monday" });
  });

  it("orders several days by the week, not by how they were ticked", () => {
    assert.deepEqual(daysFromSelection(["friday", "monday", "wednesday"]), {
      ok: true,
      value: "monday,wednesday,friday",
    });
  });

  it("collapses all seven to the daily marker", () => {
    assert.deepEqual(daysFromSelection(ALL), { ok: true, value: "*" });
  });

  it("rejects an empty selection", () => {
    assert.equal(daysFromSelection([]).ok, false);
  });
});

describe("plannedEdit", () => {
  const stored = reminder({ at: "09:00", days: "monday", everyNWeeks: 1, message: "Standup!" });
  const roster = [
    { userId: "U_A", lapOrder: null },
    { userId: "U_B", lapOrder: 0 },
    { userId: "U_C", lapOrder: 1 },
  ];
  const unchanged = fields({
    code: undefined,
    message: "Standup!",
    at: "09:00",
    dayNames: ["monday"],
    everyNWeeks: 1,
    hosts: ["U_A", "U_B", "U_C"],
  });

  it("plans nothing when the form comes back exactly as it was opened", () => {
    assert.deepEqual(plannedEdit(stored, roster, unchanged, "09:00", "monday", 0), {});
  });

  it("leaves the roster alone when the same people come back in a different order", () => {
    const reordered = { ...unchanged, hosts: ["U_C", "U_A", "U_B"] };
    const planned = plannedEdit(stored, roster, reordered, "09:00", "monday", 0);

    assert.equal(planned.hosts, undefined, "re-planning the lap would redraw a published order");
  });

  it("does not rewrite an unchanged message, which would reset the body format", () => {
    const captured = reminder({ ...stored, bodyFormat: "mrkdwn" });
    const planned = plannedEdit(captured, roster, { ...unchanged, at: "10:00" }, "10:00", "monday", 0);

    assert.equal(planned.at, "10:00");
    assert.equal(planned.message, undefined);
  });

  it("plans each field that genuinely changed, and only those", () => {
    const edited = { ...unchanged, message: "New!", everyNWeeks: 2, hosts: ["U_A", "U_B"] };
    const planned = plannedEdit(stored, roster, edited, "16:30", "friday", 0);

    assert.deepEqual(planned, {
      at: "16:30",
      days: "friday",
      everyNWeeks: 2,
      message: "New!",
      hosts: ["U_A", "U_B"],
    });
  });

  it("plans an empty roster, which is how a rotation is cleared", () => {
    const cleared = plannedEdit(stored, roster, { ...unchanged, hosts: [] }, "09:00", "monday", 0);
    assert.deepEqual(cleared.hosts, []);
  });

  it("ignores a message block that was never rendered", () => {
    const noMessage = { ...unchanged, message: undefined };
    assert.equal(plannedEdit(stored, roster, noMessage, "09:00", "monday", 0).message, undefined);
  });
});

describe("skipModal", () => {
  const source = { channelId: "C1", messageTs: "1700000000.0001" };

  const modal = (existing?: Skip) => skipModal(source, existing) as ModalView;
  const reasonInput = (existing?: Skip) => modal(existing).blocks[0] as InputBlock;

  it("points back at the post it was opened from, which a submission does not carry", () => {
    const view = modal();

    assert.equal(view.callback_id, SKIP_FORM);
    assert.deepEqual(JSON.parse(view.private_metadata!), source);
  });

  it("lets the box be submitted empty, since a reason is optional", () => {
    assert.equal(reasonInput().optional, true);
  });

  it("caps the reason in the browser, so nothing has to re-check it on submit", () => {
    const { element } = reasonInput();
    assert.ok(element.type === "plain_text_input" && element.max_length === 200);
  });

  it("omits initial_value entirely when there is no reason, which Slack requires", () => {
    const { element } = reasonInput();
    assert.ok(element.type === "plain_text_input");
    assert.ok(!("initial_value" in element));
  });

  it("prefills an existing reason so it can be corrected", () => {
    const { element } = reasonInput({ userId: "U_B", reason: "sick" });
    assert.ok(element.type === "plain_text_input" && element.initial_value === "sick");
  });

  it("is where someone learns they already skipped, since the button cannot say so", () => {
    const fresh = modal();
    assert.deepEqual(fresh.title, { type: "plain_text", text: "Skip me" });
    assert.deepEqual(fresh.submit, { type: "plain_text", text: "Skip" });

    const again = modal({ userId: "U_B", reason: null });
    assert.deepEqual(again.title, { type: "plain_text", text: "You're skipping" });
    assert.deepEqual(again.submit, { type: "plain_text", text: "Save" });
  });
});

describe("readSkipReason", () => {
  it("reads and trims what was typed", () => {
    assert.equal(readSkipReason(values({ reason: { value: "  sick " } })), "sick");
  });

  it("reads a blank box as no reason at all", () => {
    for (const state of [{ value: "" }, { value: "   " }, { value: null }]) {
      assert.equal(readSkipReason(values({ reason: state })), undefined);
    }
    assert.equal(readSkipReason(values({})), undefined);
  });
});

describe("validate — the heads-up", () => {
  const ok = (result: ReturnType<typeof validate>) => {
    assert.ok(!("errors" in result));
    return result;
  };

  it("defaults to none when the box is empty", () => {
    assert.equal(ok(validate(fields(), NONE)).leadMinutes, 0);
  });

  it("takes a plain number of minutes", () => {
    const result = validate(fields({ lead: "55", preMessage: "Daily Standup" }), NONE);
    assert.equal(ok(result).leadMinutes, 55);
  });

  it("refuses anything that is not digits", () => {
    const result = validate(fields({ lead: "55m", preMessage: "x" }), NONE);
    assert.ok("errors" in result && result.errors.lead);
  });

  it("refuses a lead that would reach back past midnight", () => {
    const result = validate(fields({ at: "00:15", lead: "60", preMessage: "x" }), NONE);
    assert.ok("errors" in result && /the day before/.test(result.errors.lead ?? ""));
  });

  it("requires something to say once a lead is set", () => {
    const result = validate(fields({ lead: "55" }), NONE);
    assert.ok("errors" in result && result.errors.preMessage);
  });

  it("wants no heads-up message when there is no lead", () => {
    assert.ok(!("errors" in validate(fields(), NONE)));
  });
});

describe("plannedEdit — the heads-up", () => {
  const stored = reminder({ at: "09:00", days: "monday", leadMinutes: 55, preMessage: "Standup" });
  const roster: Host[] = [];
  const same = fields({
    code: undefined,
    message: stored.message,
    at: "09:00",
    dayNames: ["monday"],
    preMessage: "Standup",
    hosts: [],
  });

  it("plans nothing when neither field moved", () => {
    assert.deepEqual(plannedEdit(stored, roster, same, "09:00", "monday", 55), {});
  });

  it("plans the lead on its own when only it changed", () => {
    const planned = plannedEdit(stored, roster, same, "09:00", "monday", 30);
    assert.deepEqual(planned, { leadMinutes: 30 });
  });

  it("clears the heads-up message to null when the box is emptied", () => {
    const emptied = { ...same, preMessage: undefined };
    const planned = plannedEdit(stored, roster, emptied, "09:00", "monday", 0);
    assert.deepEqual(planned, { leadMinutes: 0, preMessage: null });
  });
});
