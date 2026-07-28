import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  drawLap,
  drawLapAvoiding,
  hasHosted,
  moveToBack,
  moveToFront,
  pendingLap,
  planLap,
  shuffle,
} from "../../src/domain/rotation.js";
import type { Host } from "../../src/domain/types.js";

const ROSTER = ["alice", "bob", "cara"];

const scripted = (values: readonly number[]) => {
  let index = 0;
  return () => values[index++]!;
};

/** Every draw picks the highest index in range, which Fisher–Yates leaves untouched. */
const noSwaps = () => 0.999;

describe("shuffle", () => {
  it("produces the permutation its random sequence dictates", () => {
    assert.deepEqual(shuffle(ROSTER, scripted([0, 0])), ["bob", "cara", "alice"]);
  });

  it("leaves the order alone when every swap is a self-swap", () => {
    assert.deepEqual(shuffle(ROSTER, noSwaps), ROSTER);
  });

  it("does not mutate its input", () => {
    const original = [...ROSTER];
    shuffle(ROSTER, scripted([0, 0]));
    assert.deepEqual(ROSTER, original);
  });

  it("handles empty and single-item lists", () => {
    assert.deepEqual(shuffle([], noSwaps), []);
    assert.deepEqual(shuffle(["alice"], noSwaps), ["alice"]);
  });
});

describe("drawLap", () => {
  it("pins the given user at the head and shuffles the rest", () => {
    assert.deepEqual(drawLap(ROSTER, "alice", scripted([0])), ["alice", "cara", "bob"]);
  });

  it("shuffles everyone when the pinned user is no longer on the roster", () => {
    assert.deepEqual(drawLap(ROSTER, "dave", scripted([0, 0])), ["bob", "cara", "alice"]);
  });

  it("shuffles everyone when nothing is pinned", () => {
    assert.deepEqual(drawLap(ROSTER, undefined, scripted([0, 0])), ["bob", "cara", "alice"]);
  });

  it("keeps the whole roster whatever is pinned", () => {
    assert.deepEqual([...drawLap(ROSTER, "cara", noSwaps)].sort(), [...ROSTER].sort());
  });
});

describe("drawLapAvoiding", () => {
  it("swaps the head away when the draw lands on the skipped person", () => {
    // noSwaps draws ["alice", "bob", "cara"], so alice must be swapped off the head.
    assert.deepEqual(drawLapAvoiding(ROSTER, "alice", noSwaps), ["bob", "alice", "cara"]);
  });

  it("leaves a draw that already avoids them alone", () => {
    assert.deepEqual(drawLapAvoiding(ROSTER, "cara", noSwaps), ROSTER);
  });

  it("cannot avoid the only member of a one-person roster", () => {
    assert.deepEqual(drawLapAvoiding(["alice"], "alice", noSwaps), ["alice"]);
  });
});

describe("hasHosted", () => {
  it("is true only for a null lapOrder", () => {
    assert.equal(hasHosted({ userId: "alice", lapOrder: null }), true);
    assert.equal(hasHosted({ userId: "alice", lapOrder: 1 }), false);
  });

  it("treats lapOrder 0 as pending — it is the up-next slot, and it is falsy", () => {
    assert.equal(hasHosted({ userId: "alice", lapOrder: 0 }), false);
  });
});

describe("pendingLap", () => {
  it("keeps only pending members, in the order given", () => {
    const roster: Host[] = [
      { userId: "alice", lapOrder: null },
      { userId: "bob", lapOrder: 0 },
      { userId: "cara", lapOrder: 1 },
    ];
    assert.deepEqual(pendingLap(roster), ["bob", "cara"]);
  });

  it("is empty once everyone has hosted, and for no roster at all", () => {
    assert.deepEqual(pendingLap(ROSTER.map((userId) => ({ userId, lapOrder: null }))), []);
    assert.deepEqual(pendingLap([]), []);
  });

  it("returns the whole roster on a fresh lap", () => {
    assert.deepEqual(
      pendingLap(ROSTER.map((userId, lapOrder) => ({ userId, lapOrder }))),
      ROSTER,
    );
  });
});

describe("planLap", () => {
  // alice has hosted; bob is up next; cara is still to come.
  const midLap: Host[] = [
    { userId: "alice", lapOrder: null },
    { userId: "bob", lapOrder: 0 },
    { userId: "cara", lapOrder: 1 },
  ];

  it("leaves whoever already hosted out of the lap", () => {
    assert.deepEqual(planLap(midLap, ROSTER, noSwaps), ["bob", "cara"]);
  });

  it("keeps whoever was up at the head, and lets a newcomer join this lap", () => {
    const withDave = planLap(midLap, [...ROSTER, "dave"], noSwaps);
    assert.deepEqual(withDave, ["bob", "cara", "dave"]);
  });

  it("re-draws from the top when whoever was up got dropped", () => {
    assert.deepEqual(planLap(midLap, ["alice", "cara"], noSwaps), ["cara"]);
  });

  it("starts a fresh lap once every member has hosted", () => {
    const lapDone = ROSTER.map((userId) => ({ userId, lapOrder: null }));
    assert.deepEqual(planLap(lapDone, ROSTER, noSwaps), ROSTER);
  });

  it("draws a full lap for a roster set for the first time", () => {
    assert.deepEqual(planLap([], ROSTER, scripted([0, 0])), ["bob", "cara", "alice"]);
  });
});

describe("moveToFront", () => {
  it("moves someone already in the lap", () => {
    assert.deepEqual(moveToFront(ROSTER, "bob"), ["bob", "alice", "cara"]);
  });

  it("is a no-op for whoever is already up", () => {
    assert.deepEqual(moveToFront(ROSTER, "alice"), ROSTER);
  });

  it("inserts someone absent from the lap — how `host next` re-adds a past host", () => {
    assert.deepEqual(moveToFront(ROSTER, "dave"), ["dave", "alice", "bob", "cara"]);
  });
});

describe("moveToBack", () => {
  it("sends whoever is up to the end", () => {
    assert.deepEqual(moveToBack(ROSTER, "alice"), ["bob", "cara", "alice"]);
  });

  it("is a no-op for someone already last", () => {
    assert.deepEqual(moveToBack(ROSTER, "cara"), ROSTER);
  });

  it("cannot reorder a single-item lap — why `skip` needs its own lap-closing path", () => {
    assert.deepEqual(moveToBack(["alice"], "alice"), ["alice"]);
  });
});
