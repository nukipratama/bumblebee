import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SocketModeReceiver } from "@slack/bolt";
import { patchAckRetry, withOneRetry } from "../../src/app/socket-mode-ack-retry.js";
import { recordingLogger } from "../helpers/store.js";

function fakeReceiver(send: unknown): SocketModeReceiver {
  return { client: { send } } as unknown as SocketModeReceiver;
}

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

  it("calls onRetrySuccess only when the retry is what saved the call", async () => {
    let successes = 0;
    await withOneRetry(async () => "ok", 1, () => successes++);
    assert.equal(successes, 0);

    let calls = 0;
    await withOneRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("first attempt failed");
        return "ok";
      },
      1,
      () => successes++,
    );
    assert.equal(successes, 1);
  });
});

describe("patchAckRetry", () => {
  it("wraps client.send so a single failure is retried and eventually succeeds", async () => {
    let calls = 0;
    const receiver = fakeReceiver(async () => {
      calls += 1;
      if (calls === 1) throw new Error("socket reconnecting");
    });
    const logger = recordingLogger();

    patchAckRetry(receiver, logger);
    await (receiver.client as unknown as { send: (id: string) => Promise<void> }).send("env-1");

    assert.equal(calls, 2);
    assert.ok(logger.calls.some((call) => call.level === "info" && /retry succeeded/.test(call.message)));
  });

  it("degrades to a no-op with a warning when client.send is not a function", () => {
    const receiver = fakeReceiver(undefined);
    const logger = recordingLogger();

    assert.doesNotThrow(() => patchAckRetry(receiver, logger));
    assert.ok(logger.calls.some((call) => call.level === "warn" && /ack retry is disabled/.test(call.message)));
  });
});
