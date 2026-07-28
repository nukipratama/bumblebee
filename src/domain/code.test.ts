import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isReminderCode, suggestCode } from "./code.js";

describe("isReminderCode", () => {
  it("accepts lowercase letters, numbers and dashes", () => {
    for (const code of ["standup", "sprint-2", "a1"]) {
      assert.equal(isReminderCode(code), true);
    }
  });

  it("rejects uppercase, spaces, punctuation and the empty string", () => {
    for (const code of ["Standup", "sprint planning", "stand_up", ""]) {
      assert.equal(isReminderCode(code), false);
    }
  });
});

describe("suggestCode", () => {
  const none = new Set<string>();

  it("slugs the opening words", () => {
    assert.equal(suggestCode("Standup time! Please join", none), "standup-time-please");
  });

  it("ignores mentions, channel links and broadcasts", () => {
    assert.equal(suggestCode("<@U1|alice> sprint planning <!channel>", none), "sprint-planning");
    assert.equal(suggestCode("<#C1|eng> code freeze", none), "code-freeze");
  });

  it("falls back when nothing usable survives", () => {
    assert.equal(suggestCode("<@U1|alice>", none), "reminder");
    assert.equal(suggestCode("🎉 ✨", none), "reminder");
    assert.equal(suggestCode("", none), "reminder");
  });

  it("keeps whole words rather than cutting one in half", () => {
    const code = suggestCode("extraordinarily circumlocutory pronouncement", none);
    assert.equal(code, "extraordinarily");
  });

  it("still yields something when the first word alone is too long", () => {
    const code = suggestCode("a".repeat(40), none);
    assert.equal(code, "a".repeat(24));
  });

  it("suffixes past anything already taken", () => {
    assert.equal(suggestCode("standup", new Set(["standup"])), "standup-2");
    assert.equal(suggestCode("standup", new Set(["standup", "standup-2"])), "standup-3");
  });
});
