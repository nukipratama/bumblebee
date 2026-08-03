import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EDIT_REMINDER_ACTION,
  HOST_CURRENT_ACTION,
  NEW_REMINDER_ACTION,
  REMOVE_REMINDER_ACTION,
  RUN_REMINDER_ACTION,
  currentHostBlockId,
  fallbackText,
  reminderBlocks,
  reminderDetailBlocks,
  reminderListBlocks,
  SKIP_ACTION,
  type ReminderPost,
  type ReminderRow,
} from "../../src/slack/blocks.js";

function post(overrides: Partial<ReminderPost> = {}): ReminderPost {
  return {
    code: "standup",
    body: "Standup time!",
    bodyFormat: "markdown",
    skips: [],
    skippable: false,
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

/** The context minus the code, which leads it on every post — see its own describe below. */
function hostContext(blocks: ReturnType<typeof reminderBlocks>): string | undefined {
  const lines = contextText(blocks)?.split("\n").slice(1) ?? [];
  return lines.length > 0 ? lines.join("\n") : undefined;
}

const skip = (userId: string, reason: string | null = null) => ({ userId, reason });

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

describe("reminderBlocks — host and skips", () => {
  it("says nothing about hosting when there is neither", () => {
    assert.equal(hostContext(reminderBlocks(post())), undefined);
  });

  it("names the host as a real mention", () => {
    assert.equal(hostContext(reminderBlocks(post({ host: "U_ALICE" }))), "🎙 Host: <@U_ALICE>");
  });

  it("lists one person skipping", () => {
    const text = hostContext(reminderBlocks(post({ skips: [skip("U_BOB")] })));
    assert.equal(text, "🙅 Skip:\n• <@U_BOB>");
  });

  it("gives each person their own line, in the order given", () => {
    const text = hostContext(reminderBlocks(post({ skips: [skip("U_BOB"), skip("U_DANA")] })));
    assert.equal(text, "🙅 Skip:\n• <@U_BOB>\n• <@U_DANA>");
  });

  it("shows a reason beside whoever gave one, and nothing extra for whoever did not", () => {
    const text = hostContext(
      reminderBlocks(post({ skips: [skip("U_BOB", "dentist"), skip("U_DANA")] })),
    );
    assert.equal(text, "🙅 Skip:\n• <@U_BOB> - dentist\n• <@U_DANA>");
  });

  it("escapes a reason, so `<!channel>` in one cannot ping the channel on every repost", () => {
    const text = hostContext(
      reminderBlocks(post({ skips: [skip("U_BOB", "ask <!channel> & co")] })),
    );
    assert.equal(text, "🙅 Skip:\n• <@U_BOB> - ask &lt;!channel&gt; &amp; co");
  });

  it("keeps a long reason whole rather than truncating it", () => {
    const reason = "a".repeat(200);
    const text = hostContext(reminderBlocks(post({ skips: [skip("U_BOB", reason)] })));
    assert.ok(text?.includes(reason));
  });

  it("puts the skips below the host, so a long list never crowds it", () => {
    const text = hostContext(
      reminderBlocks(post({ host: "U_ALICE", skips: [skip("U_BOB"), skip("U_DANA")] })),
    );
    assert.equal(text, "🎙 Host: <@U_ALICE>\n🙅 Skip:\n• <@U_BOB>\n• <@U_DANA>");
  });

  it("reports that nobody is hosting when a handover found no one available", () => {
    const text = hostContext(
      reminderBlocks(post({ hostUnavailable: true, skips: [skip("U_BOB"), skip("U_ALICE")] })),
    );
    assert.equal(text, "⚠️ Nobody available to host\n🙅 Skip:\n• <@U_BOB>\n• <@U_ALICE>");
  });

  it("names the host rather than the warning whenever there is one", () => {
    const text = hostContext(reminderBlocks(post({ host: "U_CARA", hostUnavailable: true })));
    assert.equal(text, "🎙 Host: <@U_CARA>");
  });

  it("stays silent about hosting on a reminder that never had a roster", () => {
    assert.deepEqual(typeOf(reminderBlocks(post({ skips: [] }))), ["markdown", "context"]);
    assert.equal(hostContext(reminderBlocks(post({ skips: [] }))), undefined);
  });

  it("leaves no stray blank line when only one of the two is present", () => {
    assert.equal(hostContext(reminderBlocks(post({ host: "U_ALICE" }))), "🎙 Host: <@U_ALICE>");
    assert.equal(
      hostContext(reminderBlocks(post({ skips: [skip("U_BOB")] }))),
      "🙅 Skip:\n• <@U_BOB>",
    );
  });
});

describe("reminderBlocks — the code", () => {
  it("names the reminder on every post, so a post leads back to `show <code>`", () => {
    for (const overrides of [{}, { host: "U_ALICE" }, { skips: [skip("U_BOB")] }]) {
      assert.match(contextText(reminderBlocks(post(overrides))) ?? "", /^⚙️ `standup`/);
    }
  });

  it("puts it first, above whoever is hosting", () => {
    const text = contextText(reminderBlocks(post({ host: "U_ALICE", skips: [skip("U_BOB")] })));
    assert.equal(text, "⚙️ `standup`\n🎙 Host: <@U_ALICE>\n🙅 Skip:\n• <@U_BOB>");
  });
});

describe("reminderBlocks — skip button", () => {
  it("is absent unless the reminder is skippable", () => {
    assert.ok(!typeOf(reminderBlocks(post())).includes("actions"));
  });

  it("reads the same for everyone, since one post cannot render per viewer", () => {
    const blocks = reminderBlocks(post({ skippable: true, skips: [skip("U_BOB")] }));
    const actions = blocks.find((block) => block.type === "actions");
    assert.ok(actions && actions.type === "actions");
    assert.deepEqual(actions.elements, [
      {
        type: "button",
        action_id: SKIP_ACTION,
        text: { type: "plain_text", text: "Skip me" },
      },
    ]);
  });
});

describe("fallbackText", () => {
  it("is never empty, in every permutation", () => {
    for (const bodyFormat of ["markdown", "mrkdwn"] as const) {
      for (const host of [undefined, "U_ALICE"]) {
        for (const skips of [[], [skip("U_BOB")]]) {
          for (const skippable of [false, true]) {
            const text = fallbackText(post({ bodyFormat, host, skips, skippable }));
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

const row = (code: string): ReminderRow => ({ code, at: "09:00", recurrence: "weekdays" });

const actionIds = (blocks: ReturnType<typeof reminderListBlocks>): string[] =>
  blocks.flatMap((block) =>
    block.type === "actions"
      ? block.elements.map((element) => ("action_id" in element ? element.action_id! : ""))
      : [],
  );

describe("reminderListBlocks", () => {
  it("offers a way in when the channel has none, or there would be none", () => {
    const blocks = reminderListBlocks([]);

    assert.ok(actionIds(blocks).includes(NEW_REMINDER_ACTION));
    assert.match(JSON.stringify(blocks[0]), /No reminders/);
  });

  it("gives every row all three actions, each carrying its own code", () => {
    const blocks = reminderListBlocks([row("standup"), row("retro")]);
    const rowActions = blocks.filter((block) => block.type === "actions").slice(0, 2);

    for (const [index, block] of rowActions.entries()) {
      assert.ok(block.type === "actions");
      assert.deepEqual(
        block.elements.map((element) => ("action_id" in element ? element.action_id : "")),
        [EDIT_REMINDER_ACTION, RUN_REMINDER_ACTION, REMOVE_REMINDER_ACTION],
      );
      for (const element of block.elements) {
        assert.equal("value" in element ? element.value : "", ["standup", "retro"][index]);
      }
    }
  });

  it("names what it could not fit rather than dropping it silently", () => {
    const codes = Array.from({ length: 25 }, (_, index) => `r${index}`);
    const blocks = reminderListBlocks(codes.map(row));

    assert.ok(blocks.length <= 50, `expected at most 50 blocks, got ${blocks.length}`);
    const note = blocks.find(
      (block) => block.type === "context" && JSON.stringify(block).includes("more, without buttons"),
    );
    assert.ok(note, "expected a note naming the overflow");
    assert.ok(JSON.stringify(note).includes("r24"));
  });
});

describe("reminderDetailBlocks", () => {
  const actionsBlocks = (blocks: ReturnType<typeof reminderDetailBlocks>) =>
    blocks.filter((block) => block.type === "actions");

  it("has no rotation section at all without a roster", () => {
    const blocks = reminderDetailBlocks({ code: "standup", body: "hi" });
    assert.ok(!blocks.some((block) => block.type === "actions"));
  });

  it("shows the current-host picker once it has fired today", () => {
    const blocks = reminderDetailBlocks({
      code: "standup",
      body: "hi",
      rotation: "*rotation*",
      firedToday: true,
    });

    const actions = actionsBlocks(blocks);
    assert.equal(actions.length, 2);
    assert.equal(actions[0]!.block_id, "standup");
    assert.equal(actions[1]!.block_id, currentHostBlockId("standup"));
    assert.deepEqual(actions[1]!.elements, [
      {
        type: "users_select",
        action_id: HOST_CURRENT_ACTION,
        placeholder: { type: "plain_text", text: "Set current host" },
      },
    ]);
    assert.ok(JSON.stringify(blocks).includes("Rotation"));
    assert.ok(JSON.stringify(blocks).includes("Current"));
  });

  it("hides the picker and explains why when nothing has fired today", () => {
    const blocks = reminderDetailBlocks({
      code: "standup",
      body: "hi",
      rotation: "*rotation*",
      firedToday: false,
    });

    const actions = actionsBlocks(blocks);
    assert.equal(actions.length, 1);
    assert.equal(actions[0]!.block_id, "standup");
    assert.ok(JSON.stringify(blocks).includes("can be set once `standup` has fired today"));
  });

  it("defaults to hidden when firedToday is not passed", () => {
    const blocks = reminderDetailBlocks({ code: "standup", body: "hi", rotation: "*rotation*" });
    assert.equal(actionsBlocks(blocks).length, 1);
  });

  it("leaves the existing rotation row's block id and elements untouched", () => {
    const blocks = reminderDetailBlocks({
      code: "standup",
      body: "hi",
      rotation: "*rotation*",
      firedToday: true,
    });

    const rotationRow = actionsBlocks(blocks)[0]!;
    assert.equal(rotationRow.block_id, "standup");
    assert.equal(rotationRow.elements.length, 2);
    assert.equal(rotationRow.elements[0]!.type, "button");
    assert.equal(rotationRow.elements[1]!.type, "users_select");
  });
});
