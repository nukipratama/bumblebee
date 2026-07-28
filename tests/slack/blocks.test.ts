import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fallbackText, reminderBlocks, SKIP_ACTION, type ReminderPost } from "../../src/slack/blocks.js";

function post(overrides: Partial<ReminderPost> = {}): ReminderPost {
  return {
    body: "Standup time!",
    bodyFormat: "markdown",
    outToday: [],
    skippable: false,
    windowClosed: false,
    ...overrides,
  };
}

const typeOf = (blocks: ReturnType<typeof reminderBlocks>): string[] =>
  blocks.map((block) => block.type);

function contextText(blocks: ReturnType<typeof reminderBlocks>): string | undefined {
  const block = blocks.find((candidate) => candidate.type === "context");
  if (!block || block.type !== "context") return undefined;
  const element = block.elements[0];
  return element && "text" in element ? element.text : undefined;
}

describe("reminderBlocks — body dialect", () => {
  it("renders a Markdown body through a markdown block", () => {
    const [body] = reminderBlocks(post({ bodyFormat: "markdown", body: "**bold**" }));
    assert.deepEqual(body, { type: "markdown", text: "**bold**" });
  });

  it("renders an mrkdwn body through a section block", () => {
    const [body] = reminderBlocks(post({ bodyFormat: "mrkdwn", body: "*bold*" }));
    assert.deepEqual(body, { type: "section", text: { type: "mrkdwn", text: "*bold*" } });
  });

  it("never converts the body", () => {
    const asterisks = "*word* and **word**";
    for (const bodyFormat of ["markdown", "mrkdwn"] as const) {
      const [body] = reminderBlocks(post({ bodyFormat, body: asterisks }));
      assert.ok(JSON.stringify(body).includes(asterisks));
    }
  });
});

describe("reminderBlocks — host and out-today", () => {
  it("omits the context line when there is neither", () => {
    assert.deepEqual(typeOf(reminderBlocks(post())), ["markdown"]);
  });

  it("names the host as a real mention", () => {
    assert.equal(contextText(reminderBlocks(post({ host: "U_ALICE" }))), "🎙 Host: <@U_ALICE>");
  });

  it("lists one person out", () => {
    const text = contextText(reminderBlocks(post({ outToday: ["U_BOB"] })));
    assert.equal(text, "🚪 Out today: <@U_BOB>");
  });

  it("lists several people out, in the order given", () => {
    const text = contextText(reminderBlocks(post({ outToday: ["U_BOB", "U_DANA"] })));
    assert.equal(text, "🚪 Out today: <@U_BOB>, <@U_DANA>");
  });

  it("puts out-today on its own line, so a long list never crowds the host", () => {
    const text = contextText(
      reminderBlocks(post({ host: "U_ALICE", outToday: ["U_BOB", "U_DANA"] })),
    );
    assert.equal(text, "🎙 Host: <@U_ALICE>\n🚪 Out today: <@U_BOB>, <@U_DANA>");
  });

  it("leaves no stray blank line when only one of the two is present", () => {
    assert.equal(contextText(reminderBlocks(post({ host: "U_ALICE" }))), "🎙 Host: <@U_ALICE>");
    assert.equal(
      contextText(reminderBlocks(post({ outToday: ["U_BOB"] }))),
      "🚪 Out today: <@U_BOB>",
    );
  });
});

describe("reminderBlocks — skip button", () => {
  it("is absent unless the reminder is skippable", () => {
    assert.ok(!typeOf(reminderBlocks(post())).includes("actions"));
  });

  it("is present and open while the window is live", () => {
    const blocks = reminderBlocks(post({ skippable: true }));
    const actions = blocks.find((block) => block.type === "actions");
    assert.ok(actions && actions.type === "actions");
    assert.deepEqual(actions.elements, [
      {
        type: "button",
        action_id: SKIP_ACTION,
        text: { type: "plain_text", text: "Skip today" },
        value: "open",
      },
    ]);
  });

  it("reports itself closed rather than disappearing once the window passes", () => {
    const blocks = reminderBlocks(post({ skippable: true, windowClosed: true }));
    const actions = blocks.find((block) => block.type === "actions");
    assert.ok(actions && actions.type === "actions");
    const [button] = actions.elements;
    assert.ok(button && "text" in button && button.text?.text === "Skip closed");
  });
});

describe("fallbackText", () => {
  it("is never empty, in every permutation", () => {
    for (const bodyFormat of ["markdown", "mrkdwn"] as const) {
      for (const host of [undefined, "U_ALICE"]) {
        for (const outToday of [[], ["U_BOB"]]) {
          for (const skippable of [false, true]) {
            const text = fallbackText(post({ bodyFormat, host, outToday, skippable }));
            assert.ok(text.length > 0);
          }
        }
      }
    }
  });

  it("names the host so a notification says whose turn it is", () => {
    assert.equal(fallbackText(post({ host: "U_ALICE" })), "Standup time! — host <@U_ALICE>");
  });
});
