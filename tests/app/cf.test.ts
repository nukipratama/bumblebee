import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { fakeClient, fakeLogger, useTempDatabase } from "../helpers/store.js";

useTempDatabase();

const { initDb, stmt } = await import("../../src/store/database.js");
const { getMessageByTs, replaceRepos } = await import("../../src/store/cf.js");
const { startCfRound } = await import("../../src/app/cf.js");

initDb();

beforeEach(() => {
  for (const table of ["cf_responses", "cf_messages", "cf_rounds", "cf_repos"]) {
    stmt(`DELETE FROM ${table}`).run();
  }
});

describe("startCfRound", () => {
  it("posts one message per configured repo and records each one", async () => {
    replaceRepos("C1", ["pms", "mamikos-web"]);
    const { client, posted } = fakeClient();

    const result = await startCfRound(client, "U1", "C1");

    assert.equal(result.repoCount, 2);
    assert.deepEqual(result.failedRepos, []);
    assert.equal(posted.length, 2);
    assert.ok(posted.every((message) => message.channel === "C1"));
  });

  it("does nothing and reports zero repos when none are configured", async () => {
    const { client } = fakeClient();
    const result = await startCfRound(client, "U1", "C1");
    assert.deepEqual(result, { repoCount: 0, failedRepos: [] });
  });

  it("keeps posting the rest of the round when one repo's post fails", async () => {
    replaceRepos("C1", ["pms", "mamikos-web", "pms-ss"]);
    let calls = 0;
    const { client, posted } = fakeClient(async () => {
      calls += 1;
      if (calls === 2) throw new Error("rate_limited");
      return { ts: `${calls}.0` };
    });

    const result = await startCfRound(client, "U1", "C1", fakeLogger());

    assert.equal(result.repoCount, 3);
    assert.deepEqual(result.failedRepos, ["mamikos-web"]);
    assert.equal(posted.length, 3, "every repo is still attempted, even after one fails");
  });

  it("only records a message for a post that actually returned a ts", async () => {
    replaceRepos("C1", ["pms"]);
    const { client } = fakeClient(async () => ({}));

    await startCfRound(client, "U1", "C1");

    assert.equal(getMessageByTs("anything"), undefined);
    assert.equal(stmt("SELECT COUNT(*) AS n FROM cf_messages").get()!.n, 0);
  });
});
