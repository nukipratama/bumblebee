import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CF_REPO_REMOVE_ACTION,
  CF_STATUS_ACTION,
  cfRepoBlocks,
  cfSettingsBlocks,
  type CfButtonValue,
} from "../../src/slack/cf-blocks.js";
import type { CfResponse } from "../../src/domain/cf.js";

const typeOf = (blocks: ReturnType<typeof cfRepoBlocks>): string[] =>
  blocks.map((block) => block.type);

describe("cfRepoBlocks", () => {
  it("renders a header section followed by one section+actions pair per squad", () => {
    const blocks = cfRepoBlocks({ name: "mamikos-web" }, []);
    assert.deepEqual(typeOf(blocks), [
      "section",
      "section",
      "actions",
      "section",
      "actions",
      "section",
      "actions",
      "section",
      "actions",
    ]);
  });

  it("shows a waiting placeholder for a squad with no response", () => {
    const [, squadSection] = cfRepoBlocks({ name: "mamikos-web" }, []);
    assert.ok(squadSection && squadSection.type === "section");
    assert.match((squadSection.text as { text: string }).text, /not yet reported/);
  });

  it("shows the reported status and reporter", () => {
    const responses: CfResponse[] = [{ squad: "SS", status: "all_merged", respondedBy: "U1" }];
    const [, squadSection] = cfRepoBlocks({ name: "mamikos-web" }, responses);
    assert.ok(squadSection && squadSection.type === "section");
    const text = (squadSection.text as { text: string }).text;
    assert.match(text, /All Merged/);
    assert.match(text, /<@U1>/);
  });

  it("gives each squad its own actions block with 2 buttons carrying a confirm dialog", () => {
    const blocks = cfRepoBlocks({ name: "mamikos-web" }, []);
    const actionsBlocks = blocks.filter((block) => block.type === "actions");
    assert.equal(actionsBlocks.length, 4);

    for (const block of actionsBlocks) {
      assert.ok(block.type === "actions");
      assert.equal(block.elements.length, 2);
      for (const element of block.elements) {
        assert.ok(element.type === "button");
        assert.ok(element.action_id?.startsWith(CF_STATUS_ACTION));
        assert.ok(element.confirm);
        const value = JSON.parse(element.value!) as CfButtonValue;
        assert.ok(["all_merged", "no_mr"].includes(value.status));
      }
    }
  });

  it("gives every status button a unique action_id", () => {
    const blocks = cfRepoBlocks({ name: "mamikos-web" }, []);
    const ids = blocks
      .filter((block) => block.type === "actions")
      .flatMap((block) => block.elements.map((el) => (el as { action_id: string }).action_id));
    assert.equal(new Set(ids).size, ids.length);
  });

  it("prepends every configured mention, users and groups mixed", () => {
    const [header] = cfRepoBlocks({ name: "mamikos-web" }, [], [
      { kind: "user", id: "U1" },
      { kind: "usergroup", id: "S123", handle: "esls" },
    ]);
    assert.ok(header && header.type === "section");
    assert.match((header.text as { text: string }).text, /^<@U1> <!subteam\^S123> \*Code Freeze Status\*/);
  });

  it("has no mention prefix when none is configured", () => {
    const [header] = cfRepoBlocks({ name: "mamikos-web" }, []);
    assert.ok(header && header.type === "section");
    assert.match((header.text as { text: string }).text, /^\*Code Freeze Status\*/);
  });
});

describe("cfSettingsBlocks", () => {
  it("shows 'none configured' when there are no repos", () => {
    const [, repoLine] = cfSettingsBlocks({ repoNames: [], mentions: [] });
    assert.ok(repoLine && repoLine.type === "section");
    assert.match((repoLine.text as { text: string }).text, /none configured/);
  });

  it("gives each configured repo its own row with a Remove button", () => {
    const blocks = cfSettingsBlocks({ repoNames: ["mamikos-web", "pms"], mentions: [] });
    const repoRows = blocks.filter(
      (block) => block.type === "section" && "accessory" in block && block.accessory,
    );
    assert.equal(repoRows.length, 2);

    const names = repoRows.map((row) => (row as { text: { text: string } }).text.text);
    assert.deepEqual(names, ["`mamikos-web`", "`pms`"]);

    for (const row of repoRows) {
      const accessory = (row as { accessory: { action_id: string; value: string; confirm: unknown } })
        .accessory;
      assert.equal(accessory.action_id, CF_REPO_REMOVE_ACTION);
      assert.ok(names.includes(`\`${accessory.value}\``));
      assert.ok(accessory.confirm);
    }
  });

  it("shows 'not configured' when there is no recurring schedule", () => {
    const [, , , scheduleLine] = cfSettingsBlocks({ repoNames: [], mentions: [] });
    assert.ok(scheduleLine && scheduleLine.type === "section");
    assert.match((scheduleLine.text as { text: string }).text, /not configured/);
  });

  it("describes the recurring schedule when set", () => {
    const [, , , scheduleLine] = cfSettingsBlocks({
      repoNames: [],
      mentions: [],
      schedule: { channelId: "C1", at: "09:00", days: "monday,tuesday", lastFiredDate: "2026-07-29" },
    });
    assert.ok(scheduleLine && scheduleLine.type === "section");
    const text = (scheduleLine.text as { text: string }).text;
    assert.match(text, /09:00/);
    assert.match(text, /<#C1>/);
    assert.match(text, /last run 2026-07-29/);
  });

  it("shows 'not configured' when there are no mentions", () => {
    const [, , mentionLine] = cfSettingsBlocks({ repoNames: [], mentions: [] });
    assert.ok(mentionLine && mentionLine.type === "section");
    assert.match((mentionLine.text as { text: string }).text, /not configured/);
  });

  it("shows every configured mention, users and groups mixed", () => {
    const [, , mentionLine] = cfSettingsBlocks({
      repoNames: [],
      mentions: [
        { kind: "user", id: "U1" },
        { kind: "usergroup", id: "S123", handle: "esls" },
      ],
    });
    assert.ok(mentionLine && mentionLine.type === "section");
    const text = (mentionLine.text as { text: string }).text;
    assert.match(text, /<@U1>/);
    assert.match(text, /<!subteam\^S123>/);
  });

  it("includes Edit settings and Start now buttons, with Start now requiring confirmation", () => {
    const blocks = cfSettingsBlocks({ repoNames: [], mentions: [] });
    const actions = blocks.at(-1);
    assert.ok(actions && actions.type === "actions");
    assert.equal(actions.elements.length, 2);
    const [edit, start] = actions.elements;
    assert.ok(edit?.type === "button" && start?.type === "button");
    assert.ok(start.confirm);
  });
});
