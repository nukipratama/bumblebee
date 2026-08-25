import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { SQUADS } from "../../src/domain/cf.js";
import { useTempDatabase } from "../helpers/store.js";

useTempDatabase();

const { initDb, stmt } = await import("../../src/store/database.js");
const {
  clearChannelConfig,
  clearSchedule,
  getMessageByTs,
  getResponses,
  getRoundStartedAt,
  getSchedule,
  listMentions,
  listRepos,
  listSchedules,
  recordMessage,
  replaceMentions,
  replaceRepos,
  setSchedule,
  setScheduleLastFiredDate,
  startRound,
  upsertResponse,
} = await import("../../src/store/cf.js");

initDb();

/** node:sqlite hands back null-prototype rows, which deepEqual won't match to a literal. */
const plain = <T extends object>(row: T): T => ({ ...row });

beforeEach(() => {
  // Children before parents: cf_responses -> cf_messages -> cf_rounds/cf_repos.
  for (const table of ["cf_responses", "cf_messages", "cf_rounds", "cf_repos", "cf_mentions", "cf_schedule"]) {
    stmt(`DELETE FROM ${table}`).run();
  }
});

describe("replaceRepos / listRepos", () => {
  it("round-trips names in the given order", () => {
    replaceRepos("C1", ["pms", "mamikos-web"]);
    assert.deepEqual(
      listRepos("C1").map((repo) => repo.name),
      ["pms", "mamikos-web"],
    );
  });

  it("defaults an unrestricted repo to every squad", () => {
    replaceRepos("C1", ["pms"]);
    assert.deepEqual(listRepos("C1")[0]!.squads, SQUADS);
  });

  it("restricts a repo to only the squads given", () => {
    replaceRepos("C1", ["pms"], new Map([["pms", ["SS", "LIMO"]]]));
    assert.deepEqual(listRepos("C1")[0]!.squads, ["SS", "LIMO"]);
  });

  it("deactivates whatever was there before, so a repo dropped from the new list disappears", () => {
    replaceRepos("C1", ["pms", "mamikos-web"]);
    replaceRepos("C1", ["mamikos-web"]);
    assert.deepEqual(
      listRepos("C1").map((repo) => repo.name),
      ["mamikos-web"],
    );
  });

  it("reactivates a previously-removed repo rather than duplicating it", () => {
    replaceRepos("C1", ["pms"]);
    const firstId = listRepos("C1")[0]!.id;
    replaceRepos("C1", []);
    replaceRepos("C1", ["pms"]);
    assert.equal(listRepos("C1")[0]!.id, firstId);
  });

  it("scopes repos to their channel", () => {
    replaceRepos("C1", ["pms"]);
    replaceRepos("C2", ["mamikos-web"]);
    assert.deepEqual(
      listRepos("C1").map((repo) => repo.name),
      ["pms"],
    );
  });
});

describe("schedule", () => {
  it("is absent until set", () => {
    assert.equal(getSchedule("C1"), undefined);
  });

  it("round-trips at/days and starts with no last-fired date", () => {
    setSchedule("C1", "09:00", "monday,tuesday");
    assert.deepEqual(plain(getSchedule("C1")!), {
      channelId: "C1",
      at: "09:00",
      days: "monday,tuesday",
      lastFiredDate: null,
    });
  });

  it("updates in place on a second set, rather than erroring on the unique channel_id", () => {
    setSchedule("C1", "09:00", "monday");
    setSchedule("C1", "10:30", "tuesday");
    assert.deepEqual(plain(getSchedule("C1")!), {
      channelId: "C1",
      at: "10:30",
      days: "tuesday",
      lastFiredDate: null,
    });
  });

  it("records the last-fired date separately from a schedule update", () => {
    setSchedule("C1", "09:00", "monday");
    setScheduleLastFiredDate("C1", "2026-08-24");
    assert.equal(getSchedule("C1")?.lastFiredDate, "2026-08-24");
  });

  it("lists every channel's schedule, ordered by channel", () => {
    setSchedule("C2", "09:00", "monday");
    setSchedule("C1", "10:00", "tuesday");
    assert.deepEqual(
      listSchedules().map((schedule) => schedule.channelId),
      ["C1", "C2"],
    );
  });

  it("clears the schedule outright", () => {
    setSchedule("C1", "09:00", "monday");
    clearSchedule("C1");
    assert.equal(getSchedule("C1"), undefined);
  });
});

describe("mentions", () => {
  it("round-trips users and usergroups, a usergroup carrying its handle", () => {
    replaceMentions("C1", [
      { kind: "user", id: "U1" },
      { kind: "usergroup", id: "S1", handle: "esls" },
    ]);
    assert.deepEqual(listMentions("C1").map(plain), [
      { kind: "user", id: "U1", handle: null },
      { kind: "usergroup", id: "S1", handle: "esls" },
    ]);
  });

  it("replaces rather than accumulates, since there's no active flag", () => {
    replaceMentions("C1", [{ kind: "user", id: "U1" }]);
    replaceMentions("C1", [{ kind: "user", id: "U2" }]);
    assert.deepEqual(
      listMentions("C1").map((mention) => mention.id),
      ["U2"],
    );
  });
});

describe("clearChannelConfig", () => {
  it("soft-deactivates repos but hard-deletes mentions and the schedule", () => {
    replaceRepos("C1", ["pms"]);
    replaceMentions("C1", [{ kind: "user", id: "U1" }]);
    setSchedule("C1", "09:00", "monday");

    clearChannelConfig("C1");

    assert.deepEqual(listRepos("C1"), []);
    assert.deepEqual(listMentions("C1"), []);
    assert.equal(getSchedule("C1"), undefined);
  });

  it("leaves the repo row itself intact so past rounds can still resolve it by id", () => {
    replaceRepos("C1", ["pms"]);
    const id = listRepos("C1")[0]!.id;
    clearChannelConfig("C1");
    assert.equal(stmt("SELECT id FROM cf_repos WHERE id = ?").get(id) !== undefined, true);
  });
});

describe("rounds, messages and responses", () => {
  it("starts a round and records when it started", () => {
    const roundId = startRound("U1");
    assert.ok(typeof getRoundStartedAt(roundId) === "string");
  });

  it("records a message and finds it back by its ts", () => {
    replaceRepos("C1", ["pms"]);
    const repoId = listRepos("C1")[0]!.id;
    const roundId = startRound("U1");

    recordMessage(roundId, repoId, "C1", "111.222", ["SS", "LIMO"]);

    assert.deepEqual(getMessageByTs("111.222"), { id: 1, roundId, repoId, squads: ["SS", "LIMO"] });
  });

  it("upserts a response, so a re-click overwrites rather than piling up", () => {
    replaceRepos("C1", ["pms"]);
    const repoId = listRepos("C1")[0]!.id;
    const roundId = startRound("U1");
    recordMessage(roundId, repoId, "C1", "111.222", SQUADS);
    const messageId = getMessageByTs("111.222")!.id;

    upsertResponse(messageId, "SS", "no_mr", "U1");
    upsertResponse(messageId, "SS", "all_merged", "U2");

    assert.deepEqual(getResponses(messageId).map(plain), [
      { squad: "SS", status: "all_merged", respondedBy: "U2" },
    ]);
  });
});
