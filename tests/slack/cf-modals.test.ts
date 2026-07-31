import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MENTION_GROUPS_ACTION_ID, MENTION_GROUPS_BLOCK_ID, readCfSettings, type Values } from "../../src/slack/cf-modals.js";

/** Every block uses action id `value`, except mentionGroups which uses its own. */
const values = (input: Record<string, unknown>): Values =>
  Object.fromEntries(
    Object.entries(input).map(([block, state]) => [
      block,
      { [block === MENTION_GROUPS_BLOCK_ID ? MENTION_GROUPS_ACTION_ID : "value"]: state },
    ]),
  ) as Values;

describe("readCfSettings", () => {
  it("reads selected mention users", () => {
    const read = readCfSettings(values({ mentionUsers: { selected_users: ["U1", "U2"] } }));
    assert.deepEqual(read.mentions, [
      { kind: "user", id: "U1" },
      { kind: "user", id: "U2" },
    ]);
  });

  it("reads selected mention groups from the autocomplete field, not the users' action id", () => {
    const read = readCfSettings(
      values({
        mentionGroups: {
          selected_options: [{ text: { type: "plain_text", text: "Engineering (@eng)" }, value: "S123" }],
        },
      }),
    );
    assert.deepEqual(read.mentions, [{ kind: "usergroup", id: "S123", handle: "Engineering (@eng)" }]);
  });

  it("combines users and groups when both are picked", () => {
    const read = readCfSettings(
      values({
        mentionUsers: { selected_users: ["U1"] },
        mentionGroups: {
          selected_options: [{ text: { type: "plain_text", text: "@eng" }, value: "S123" }],
        },
      }),
    );
    assert.deepEqual(read.mentions, [
      { kind: "user", id: "U1" },
      { kind: "usergroup", id: "S123", handle: "@eng" },
    ]);
  });

  it("reads no mentions when neither field was touched", () => {
    assert.deepEqual(readCfSettings(values({})).mentions, []);
  });

  it("reads repos, days, and time alongside mentions", () => {
    const read = readCfSettings(
      values({
        repos: { value: "mamikos-web\npms" },
        days: { selected_options: [{ value: "monday" }] },
        at: { value: " 09:00 " },
      }),
    );
    assert.deepEqual(read.repoNames, ["mamikos-web", "pms"]);
    assert.deepEqual(read.dayNames, ["monday"]);
    assert.equal(read.at, "09:00");
  });
});
