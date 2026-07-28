import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  daysFromSelection,
  normalizeMentions,
  parseArgs,
  parseAt,
  parseCadence,
  parseDate,
  parseDays,
  parseUserMentions,
  unescapeNewlines,
  type FlagSpec,
} from "./args.js";

const SPEC: FlagSpec = {
  withValue: ["at", "on", "message"],
  boolean: ["every-1-week", "every-2-week", "every-3-week"],
};

const parse = (text: string) => parseArgs(text, SPEC);

function expectOk<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  return (result as { ok: true; value: T }).value;
}

function expectError(result: { ok: boolean; error?: string }, fragment: string): void {
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, new RegExp(fragment, "i"));
}

describe("parseArgs", () => {
  it("reads positionals and flags", () => {
    const args = expectOk(parse("standup --at 09:00 --on monday"));
    assert.deepEqual(args.positionals, ["standup"]);
    assert.equal(args.flags.get("at"), "09:00");
    assert.equal(args.flags.get("on"), "monday");
  });

  it("keeps spaces inside quoted values", () => {
    const args = expectOk(parse('smoke --message "Standup time, everyone"'));
    assert.equal(args.flags.get("message"), "Standup time, everyone");
  });

  it("accepts --flag=value", () => {
    assert.equal(expectOk(parse("--at=09:00")).flags.get("at"), "09:00");
  });

  it("reads a boolean flag with no value", () => {
    assert.equal(expectOk(parse("sprint --every-2-week")).flags.get("every-2-week"), true);
  });

  it("rejects a repeated flag instead of taking the last one", () => {
    expectError(parse("--at 09:00 --at 10:00"), "more than once");
  });

  it("rejects an unknown flag", () => {
    expectError(parse("--min-interval 13"), "unknown flag");
  });

  it("rejects a flag missing its value", () => {
    expectError(parse("--at --on monday"), "needs a value");
  });

  it("rejects a value on a boolean flag", () => {
    expectError(parse("--every-2-week=yes"), "does not take a value");
  });

  it("rejects an unbalanced quote", () => {
    expectError(parse('--message "unterminated'), "unbalanced quote");
  });

  it("collects stray positionals so callers can reject them", () => {
    assert.deepEqual(expectOk(parse("smoke extra --at 09:00")).positionals, ["smoke", "extra"]);
  });
});

describe("parseAt", () => {
  it("accepts 24-hour times", () => {
    assert.equal(expectOk(parseAt("09:00")), "09:00");
    assert.equal(expectOk(parseAt("23:59")), "23:59");
    assert.equal(expectOk(parseAt("00:00")), "00:00");
  });

  it("rejects unpadded, out-of-range and malformed times", () => {
    for (const bad of ["9:00", "25:00", "09:60", "0900", "9am"]) {
      expectError(parseAt(bad), "24-hour time");
    }
  });
});

describe("parseDays", () => {
  it("maps daily to the wildcard", () => {
    assert.equal(expectOk(parseDays("daily")), "*");
  });

  it("canonicalises a list into week order", () => {
    assert.equal(expectOk(parseDays("wednesday,monday")), "monday,wednesday");
  });

  it("rejects abbreviations, ranges and nonsense", () => {
    for (const bad of ["mon", "mon-fri", "funday"]) {
      expectError(parseDays(bad), "is not a day");
    }
  });

  it("rejects a day listed twice", () => {
    expectError(parseDays("monday,monday"), "listed twice");
  });
});

describe("parseDate", () => {
  it("accepts a real ISO date", () => {
    assert.equal(expectOk(parseDate("2026-08-17")), "2026-08-17");
  });

  it("rejects dates that do not exist", () => {
    expectError(parseDate("2026-02-30"), "not a real date");
    expectError(parseDate("2026-13-01"), "not a real date");
  });

  it("rejects anything that is not YYYY-MM-DD", () => {
    expectError(parseDate("17-08-2026"), "not a date");
    expectError(parseDate("tomorrow"), "not a date");
  });
});

describe("parseCadence", () => {
  it("defaults to every week when no flag is given", () => {
    assert.equal(expectOk(parseCadence(new Map())), 1);
  });

  it("reads the number out of the flag name", () => {
    assert.equal(expectOk(parseCadence(new Map([["every-2-week", true as const]]))), 2);
    assert.equal(expectOk(parseCadence(new Map([["every-3-week", true as const]]))), 3);
  });

  it("rejects two cadence flags at once", () => {
    const both = new Map([
      ["every-2-week", true as const],
      ["every-3-week", true as const],
    ]);
    expectError(parseCadence(both), "only one of");
  });
});

describe("unescapeNewlines", () => {
  it("turns a literal backslash-n into a newline", () => {
    assert.equal(unescapeNewlines("a\\nb"), "a\nb");
  });

  it("leaves text without escapes alone", () => {
    assert.equal(unescapeNewlines("plain text"), "plain text");
  });
});

describe("normalizeMentions", () => {
  it("strips the label so a mention renders", () => {
    assert.equal(normalizeMentions("hi <@U123|nuki>"), "hi <@U123>");
  });

  it("leaves bare mentions and broadcasts untouched", () => {
    assert.equal(normalizeMentions("<@U123> <!channel> plain"), "<@U123> <!channel> plain");
  });
});

describe("parseUserMentions", () => {
  const ids = (tokens: string[]) => {
    const parsed = parseUserMentions(tokens);
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
    return parsed.value;
  };

  it("reads labelled and bare mentions, keeping the order given", () => {
    assert.deepEqual(ids(["<@U1|alice>", "<@U2>", "<@W3|cara>"]), ["U1", "U2", "W3"]);
  });

  it("rejects a token that is not a person", () => {
    for (const token of ["alice", "@alice", "<!channel>", "<#C1|eng>"]) {
      const parsed = parseUserMentions([token]);
      assert.equal(parsed.ok, false);
    }
  });

  it("names the escaping setting when a mention arrives as plain text", () => {
    const parsed = parseUserMentions(["@alice"]);
    assert.ok(!parsed.ok && parsed.error.includes("Escape channels, users, and links"));
  });

  it("rejects the same person twice, however they are written", () => {
    const parsed = parseUserMentions(["<@U1|alice>", "<@U1>"]);
    assert.ok(!parsed.ok && parsed.error.includes("listed twice"));
  });

  it("rejects an empty list", () => {
    assert.equal(parseUserMentions([]).ok, false);
  });
});

describe("daysFromSelection", () => {
  const ALL = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

  it("returns a single day", () => {
    const parsed = daysFromSelection(["monday"]);
    assert.deepEqual(parsed, { ok: true, value: "monday" });
  });

  it("orders several days by the week, not by how they were ticked", () => {
    const parsed = daysFromSelection(["friday", "monday", "wednesday"]);
    assert.deepEqual(parsed, { ok: true, value: "monday,wednesday,friday" });
  });

  it("collapses all seven to the daily marker, matching `--on daily`", () => {
    assert.deepEqual(daysFromSelection(ALL), { ok: true, value: "*" });
  });

  it("rejects an empty selection", () => {
    assert.equal(daysFromSelection([]).ok, false);
  });
});
