import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { withOneRetry } from "../../src/app/socket-mode-ack-retry.js";

describe("withOneRetry", () => {
  it("returns the result on the first try without retrying", async () => {
    let calls = 0;
    const result = await withOneRetry(async () => {
      calls += 1;
      return "ok";
    });

    assert.equal(result, "ok");
    assert.equal(calls, 1);
  });

  it("retries once after a failure and returns the retry's result", async () => {
    let calls = 0;
    const result = await withOneRetry(async () => {
      calls += 1;
      if (calls === 1) throw new Error("first attempt failed");
      return "ok";
    }, 1);

    assert.equal(result, "ok");
    assert.equal(calls, 2);
  });

  it("tags the error and stops after the retry also fails", async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        withOneRetry(async () => {
          calls += 1;
          throw new Error("still failing");
        }, 1),
      (error: Error & { ackRetryExhausted?: boolean }) => {
        assert.equal(error.ackRetryExhausted, true);
        return true;
      },
    );

    assert.equal(calls, 2);
  });
});
