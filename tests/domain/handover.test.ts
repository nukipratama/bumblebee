import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hostChangeOpen, meetingTimeMs } from "../../src/domain/handover.js";
import type { Fire, Reminder } from "../../src/domain/types.js";

const MINUTES = 60_000;
const FIRED_ON = "2026-07-27";
const AT = "09:00";
const MEETING = new Date(`${FIRED_ON}T${AT}:00`).getTime();

const fire = { firedOn: FIRED_ON } as Fire;
const reminder = { at: AT } as Reminder;

describe("meetingTimeMs", () => {
  it("is the local instant of fired_on + at, independent of when the fire itself posted", () => {
    assert.equal(meetingTimeMs(fire, reminder), MEETING);
  });
});

describe("hostChangeOpen", () => {
  it("is open right up to 30 minutes after the meeting", () => {
    assert.equal(hostChangeOpen(fire, reminder, MEETING + 30 * MINUTES), true);
  });

  it("is closed one minute past that", () => {
    assert.equal(hostChangeOpen(fire, reminder, MEETING + 31 * MINUTES), false);
  });

  it("is open before the meeting has even started", () => {
    assert.equal(hostChangeOpen(fire, reminder, MEETING - 50 * MINUTES), true);
  });
});
