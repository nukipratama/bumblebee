import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  describeAction,
  put,
  takeIfFreshAndOwnedBy,
  type PendingAction,
} from "../../src/slack/pending.js";

const ACTION: PendingAction = { kind: "remove", code: "standup" };
const START = 1_000_000;
const SIX_MINUTES = 6 * 60_000;

const store = (userId = "U1") => put({ action: ACTION, userId, channelId: "C1" }, START);

describe("pending", () => {
  it("returns the entry once", () => {
    const id = store();
    assert.deepEqual(takeIfFreshAndOwnedBy(id, "U1", START)?.action, ACTION);
  });

  it("returns undefined on a second take", () => {
    const id = store();
    takeIfFreshAndOwnedBy(id, "U1", START);
    assert.equal(takeIfFreshAndOwnedBy(id, "U1", START), undefined);
  });

  it("returns undefined past the TTL", () => {
    const id = store();
    assert.equal(takeIfFreshAndOwnedBy(id, "U1", START + SIX_MINUTES), undefined);
  });

  it("returns undefined for a different user", () => {
    const id = store();
    assert.equal(takeIfFreshAndOwnedBy(id, "U2", START), undefined);
  });

  it("returns undefined for an unknown id", () => {
    assert.equal(takeIfFreshAndOwnedBy("no-such-id", "U1", START), undefined);
  });
});

describe("describeAction", () => {
  it("names the reminder for an action that targets one", () => {
    assert.equal(describeAction({ kind: "run", code: "standup" }), "run standup");
    assert.equal(describeAction({ kind: "hostSkip", code: "standup" }), "hostSkip standup");
  });

  it("names the date for a holiday action", () => {
    assert.equal(
      describeAction({ kind: "holidayAdd", date: "2026-09-07" }),
      "holidayAdd 2026-09-07",
    );
  });

  it("names both the reminder and the person for a rotation change", () => {
    assert.equal(
      describeAction({ kind: "hostCurrent", code: "standup", userId: "U_A" }),
      "hostCurrent standup U_A",
    );
  });
});
