import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CF_REMOVE_CONFIG_ACTION,
  CF_STATUS_OPEN_ACTION,
  cfRepoBlocks,
  cfSettingsBlocks,
  describeCfSettingsChange,
  type CfSettingsSummary,
} from "../../src/slack/cf-blocks.js";
import { SQUADS, type CfRepo, type CfResponse } from "../../src/domain/cf.js";

const repo = (name: string, squads: readonly CfRepo["squads"][number][] = SQUADS): CfRepo => ({
  id: 1,
  name,
  squads,
});

const typeOf = (blocks: ReturnType<typeof cfRepoBlocks>): string[] =>
  blocks.map((block) => block.type);

describe("cfRepoBlocks", () => {
  it("renders a repo name header, an intro section, one section per squad, then one trailing actions block", () => {
    const blocks = cfRepoBlocks(repo("mamikos-web"), []);
    assert.deepEqual(typeOf(blocks), [
      "header",
      "section",
      "section",
      "section",
      "section",
      "section",
      "actions",
    ]);
  });

  it("puts 'Code Freeze Status — {repo}' in the large header block", () => {
    const [header] = cfRepoBlocks(repo("mamikos-web"), []);
    assert.ok(header && header.type === "header");
    assert.equal(header.text.text, "Code Freeze Status — mamikos-web");
  });

  it("shows a waiting placeholder for a squad with no response", () => {
    const [, , squadSection] = cfRepoBlocks(repo("mamikos-web"), []);
    assert.ok(squadSection && squadSection.type === "section");
    assert.match((squadSection.text as { text: string }).text, /not yet reported/);
  });

  it("shows the reported status and reporter", () => {
    const responses: CfResponse[] = [{ squad: "SS", status: "all_merged", respondedBy: "U1" }];
    const [, , squadSection] = cfRepoBlocks(repo("mamikos-web"), responses);
    assert.ok(squadSection && squadSection.type === "section");
    const text = (squadSection.text as { text: string }).text;
    assert.match(text, /All Merged/);
    assert.match(text, /<@U1>/);
  });

  it("gives a single trailing actions block with one plain button per squad, no confirm dialog", () => {
    const blocks = cfRepoBlocks(repo("mamikos-web"), []);
    const actionsBlocks = blocks.filter((block) => block.type === "actions");
    assert.equal(actionsBlocks.length, 1);

    const [actions] = actionsBlocks;
    assert.ok(actions && actions.type === "actions");
    assert.equal(actions.elements.length, SQUADS.length);
    for (const [index, element] of actions.elements.entries()) {
      assert.ok(element.type === "button");
      assert.ok(element.action_id?.startsWith(CF_STATUS_OPEN_ACTION));
      assert.equal(element.confirm, undefined);
      assert.equal(element.value, SQUADS[index]);
      assert.equal((element.text as { text: string }).text, SQUADS[index]);
    }
  });

  it("gives every squad button a unique action_id", () => {
    const blocks = cfRepoBlocks(repo("mamikos-web"), []);
    const ids = blocks
      .filter((block) => block.type === "actions")
      .flatMap((block) => block.elements.map((el) => (el as { action_id: string }).action_id));
    assert.equal(new Set(ids).size, ids.length);
  });

  it("prepends every configured mention, users and groups mixed", () => {
    const [, introSection] = cfRepoBlocks(repo("mamikos-web"), [], [
      { kind: "user", id: "U1" },
      { kind: "usergroup", id: "S123", handle: "esls" },
    ]);
    assert.ok(introSection && introSection.type === "section");
    assert.match(
      (introSection.text as { text: string }).text,
      /^<@U1> <!subteam\^S123> Please report/,
    );
  });

  it("has no mention prefix when none is configured", () => {
    const [, introSection] = cfRepoBlocks(repo("mamikos-web"), []);
    assert.ok(introSection && introSection.type === "section");
    assert.match((introSection.text as { text: string }).text, /^Please report/);
  });

  it("renders only the repo's restricted squads, not all 4", () => {
    const blocks = cfRepoBlocks(repo("pms", ["SS", "LIMO"]), []);
    const actions = blocks.find((block) => block.type === "actions");
    assert.ok(actions && actions.type === "actions");
    assert.deepEqual(
      actions.elements.map((el) => (el.type === "button" ? el.value : undefined)),
      ["SS", "LIMO"],
    );
    const sectionTexts = blocks
      .filter((block) => block.type === "section")
      .map((block) => (block.text as { text: string }).text);
    assert.ok(sectionTexts.some((text) => text.includes("*SS*")));
    assert.ok(sectionTexts.some((text) => text.includes("*LIMO*")));
    assert.ok(!sectionTexts.some((text) => text.includes("*Core BE*")));
  });
});

describe("cfSettingsBlocks", () => {
  it("shows 'none configured' when there are no repos", () => {
    const [, repoLine] = cfSettingsBlocks({ repos: [], mentions: [] });
    assert.ok(repoLine && repoLine.type === "section");
    assert.match((repoLine.text as { text: string }).text, /none configured/);
  });

  it("lists configured repos", () => {
    const [, repoLine] = cfSettingsBlocks({
      repos: [repo("mamikos-web"), repo("pms")],
      mentions: [],
    });
    assert.ok(repoLine && repoLine.type === "section");
    assert.match((repoLine.text as { text: string }).text, /mamikos-web, pms/);
  });

  it("annotates a restricted repo with its squads, leaves an unrestricted one plain", () => {
    const [, repoLine] = cfSettingsBlocks({
      repos: [repo("mamikos-web"), repo("pms", ["SS", "LIMO"])],
      mentions: [],
    });
    assert.ok(repoLine && repoLine.type === "section");
    assert.match((repoLine.text as { text: string }).text, /mamikos-web, pms \(SS, LIMO\)/);
  });

  it("shows 'not configured' when there is no recurring schedule", () => {
    const [, , , scheduleLine] = cfSettingsBlocks({ repos: [], mentions: [] });
    assert.ok(scheduleLine && scheduleLine.type === "section");
    assert.match((scheduleLine.text as { text: string }).text, /not configured/);
  });

  it("describes the recurring schedule when set", () => {
    const [, , , scheduleLine] = cfSettingsBlocks({
      repos: [],
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
    const [, , mentionLine] = cfSettingsBlocks({ repos: [], mentions: [] });
    assert.ok(mentionLine && mentionLine.type === "section");
    assert.match((mentionLine.text as { text: string }).text, /not configured/);
  });

  it("shows every configured mention, users and groups mixed", () => {
    const [, , mentionLine] = cfSettingsBlocks({
      repos: [],
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

  it("includes Edit settings, Start now, and Remove config buttons, all requiring confirmation except Edit", () => {
    const blocks = cfSettingsBlocks({ repos: [], mentions: [] });
    const actions = blocks.at(-1);
    assert.ok(actions && actions.type === "actions");
    assert.equal(actions.elements.length, 3);
    const [edit, start, removeConfig] = actions.elements;
    assert.ok(edit?.type === "button" && start?.type === "button" && removeConfig?.type === "button");
    assert.ok(start.confirm);
    assert.equal(removeConfig.action_id, CF_REMOVE_CONFIG_ACTION);
    assert.equal(removeConfig.style, "danger");
    assert.ok(removeConfig.confirm);
  });
});

describe("describeCfSettingsChange", () => {
  const empty: CfSettingsSummary = { repos: [], mentions: [] };

  it("reports an added repo", () => {
    const before: CfSettingsSummary = { ...empty, repos: [repo("mamikos-web"), repo("pms")] };
    const after: CfSettingsSummary = {
      ...empty,
      repos: [repo("mamikos-web"), repo("pms"), repo("pms-ss")],
    };
    const change = describeCfSettingsChange("U1", before, after);
    assert.match(change ?? "", /<@U1> updated the Code Freeze Report configuration/);
    assert.match(change ?? "", /added repo `pms-ss`/);
  });

  it("reports cleared mentions", () => {
    const before: CfSettingsSummary = { ...empty, mentions: [{ kind: "user", id: "U2" }] };
    const after: CfSettingsSummary = { ...empty, mentions: [] };
    assert.match(describeCfSettingsChange("U1", before, after) ?? "", /cleared mentions/);
  });

  it("reports a changed schedule time", () => {
    const before: CfSettingsSummary = {
      ...empty,
      schedule: { channelId: "C1", at: "09:00", days: "monday", lastFiredDate: null },
    };
    const after: CfSettingsSummary = {
      ...empty,
      schedule: { channelId: "C1", at: "10:30", days: "monday", lastFiredDate: null },
    };
    assert.match(
      describeCfSettingsChange("U1", before, after) ?? "",
      /changed the recurring schedule to every monday at 10:30/,
    );
  });

  it("reports multiple removed repos on a full clear", () => {
    const before: CfSettingsSummary = { ...empty, repos: [repo("mamikos-web"), repo("pms")] };
    assert.match(
      describeCfSettingsChange("U1", before, empty) ?? "",
      /removed repos `mamikos-web`, `pms`/,
    );
  });

  it("returns undefined for a no-op save", () => {
    assert.equal(describeCfSettingsChange("U1", empty, empty), undefined);
  });
});
