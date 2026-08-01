import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { KnownBlock } from "@slack/web-api";
import {
  CF_STATUS_MODAL_CANCEL_ACTION,
  CF_STATUS_MODAL_SET_ACTION_PATTERN,
  MENTION_GROUPS_ACTION_ID,
  MENTION_GROUPS_BLOCK_ID,
  cfSettingsModal,
  cfStatusModal,
  cfStatusResolvedModal,
  readCfSettings,
  repoSquadsBlockId,
  type CfStatusModalMetadata,
  type Values,
} from "../../src/slack/cf-modals.js";
import { SQUADS, type CfRepo } from "../../src/domain/cf.js";

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

  it("reads a repo's selected squads keyed by repo name", () => {
    const read = readCfSettings(
      values({
        [repoSquadsBlockId("pms")]: {
          selected_options: [{ value: "SS" }, { value: "LIMO" }],
        },
      }),
    );
    assert.deepEqual(read.repoSquads.get("pms"), ["SS", "LIMO"]);
  });

  it("reads a zero-selection squads block as an empty array, not absent", () => {
    const read = readCfSettings(values({ [repoSquadsBlockId("pms")]: { selected_options: [] } }));
    assert.deepEqual(read.repoSquads.get("pms"), []);
  });

  it("has no entry for a repo whose block wasn't rendered", () => {
    const read = readCfSettings(values({}));
    assert.equal(read.repoSquads.get("new-repo"), undefined);
  });
});

describe("cfSettingsModal", () => {
  const repo = (name: string, squads: readonly CfRepo["squads"][number][]): CfRepo => ({
    id: 1,
    name,
    squads,
  });

  it("renders one squads checkbox block per repo, pre-filled from its current squads", () => {
    const view = cfSettingsModal(
      { repos: [repo("mamikos-web", SQUADS), repo("pms", ["SS", "LIMO"])], mentions: [] },
      { channelId: "C1" },
    );

    const webBlock = view.blocks.find((block) => block.block_id === repoSquadsBlockId("mamikos-web")) as
      | { optional?: boolean; element: { options: unknown[]; initial_options?: { value: string }[] } }
      | undefined;
    assert.ok(webBlock);
    assert.equal(webBlock.optional, true);
    assert.equal(webBlock.element.options.length, SQUADS.length);
    assert.equal(webBlock.element.initial_options?.length, SQUADS.length);

    const pmsBlock = view.blocks.find((block) => block.block_id === repoSquadsBlockId("pms")) as
      | { element: { initial_options?: { value: string }[] } }
      | undefined;
    assert.ok(pmsBlock);
    assert.deepEqual(
      pmsBlock.element.initial_options?.map((option) => option.value),
      ["SS", "LIMO"],
    );
  });

  it("renders no squads block for a repo that isn't in the list yet", () => {
    const view = cfSettingsModal({ repos: [], mentions: [] }, { channelId: "C1" });
    const squadsBlocks = view.blocks.filter((block) => block.block_id?.startsWith("repoSquads:"));
    assert.equal(squadsBlocks.length, 0);
  });
});

describe("cfStatusModal", () => {
  const meta: CfStatusModalMetadata = { channelId: "C1", messageTs: "123.456", squad: "Core BE" };

  it("keeps the title within Slack's 24-character limit for every squad", () => {
    for (const squad of SQUADS) {
      const view = cfStatusModal(squad, { repoName: "mamikos-web" }, { ...meta, squad });
      assert.ok(view.type === "modal");
      assert.ok(view.title.text.length <= 24, `"${view.title.text}" is ${view.title.text.length} chars`);
      assert.match(view.title.text, new RegExp(`${squad}$`));
    }
  });

  it("shows the repo name and, when known, the round's start date", () => {
    const view = cfStatusModal("Core BE", { repoName: "mamikos-web", roundStartedAt: "2026-08-01" }, meta);
    assert.ok(view.type === "modal");
    const [intro] = view.blocks as KnownBlock[];
    assert.ok(intro && intro.type === "section");
    const text = (intro.text as { text: string }).text;
    assert.match(text, /mamikos-web/);
    assert.match(text, /2026-08-01/);
  });

  it("omits the date line entirely when the round's start date is unknown", () => {
    const view = cfStatusModal("Core BE", { repoName: "mamikos-web" }, meta);
    assert.ok(view.type === "modal");
    const [intro] = view.blocks as KnownBlock[];
    assert.ok(intro && intro.type === "section");
    assert.equal((intro.text as { text: string }).text, "mamikos-web");
  });

  it("renders exactly 3 buttons in order Cancel | No MR | All Merged, styled gray/danger/primary", () => {
    const view = cfStatusModal("Core BE", { repoName: "mamikos-web" }, meta);
    assert.ok(view.type === "modal");
    const actions = (view.blocks as KnownBlock[]).find((block) => block.type === "actions");
    assert.ok(actions && actions.type === "actions");
    assert.equal(actions.elements.length, 3);

    const [cancel, noMr, allMerged] = actions.elements;
    assert.ok(cancel?.type === "button" && noMr?.type === "button" && allMerged?.type === "button");

    assert.equal(cancel.action_id, CF_STATUS_MODAL_CANCEL_ACTION);
    assert.equal(cancel.text.text, "Cancel");
    assert.equal(cancel.style, undefined);

    assert.equal(noMr.text.text, "No MR");
    assert.equal(noMr.value, "no_mr");
    assert.equal(noMr.style, "danger");
    assert.match(noMr.action_id!, CF_STATUS_MODAL_SET_ACTION_PATTERN);

    assert.equal(allMerged.text.text, "All Merged");
    assert.equal(allMerged.value, "all_merged");
    assert.equal(allMerged.style, "primary");
    assert.match(allMerged.action_id!, CF_STATUS_MODAL_SET_ACTION_PATTERN);
  });

  it("round-trips channelId, messageTs, and squad through private_metadata", () => {
    const view = cfStatusModal("Core BE", { repoName: "mamikos-web" }, meta);
    assert.deepEqual(JSON.parse(view.private_metadata!) as CfStatusModalMetadata, meta);
  });
});

describe("cfStatusResolvedModal", () => {
  it("keeps the same squad-suffixed title and shows the given message with no buttons", () => {
    const view = cfStatusResolvedModal("Core BE", "You can close this window.");
    assert.ok(view.type === "modal");
    assert.match(view.title.text, /Core BE$/);
    assert.equal(view.blocks.length, 1);
    const [section] = view.blocks as KnownBlock[];
    assert.ok(section && section.type === "section");
    assert.equal((section.text as { text: string }).text, "You can close this window.");
    assert.ok(!view.blocks.some((block) => block.type === "actions"));
  });
});
