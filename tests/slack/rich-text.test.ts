import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RichTextBlock, RichTextElement, RichTextSection } from "@slack/types";
import { parseReasonRichText, renderRichText } from "../../src/slack/rich-text.js";

const section = (elements: RichTextElement[]): RichTextSection => ({
  type: "rich_text_section",
  elements,
});

const block = (...sections: RichTextBlock["elements"]): RichTextBlock => ({
  type: "rich_text",
  elements: sections,
});

describe("renderRichText", () => {
  it("escapes control characters in a typed text run, so it cannot fire as mrkdwn", () => {
    const text = renderRichText(block(section([{ type: "text", text: "ask <!channel> & co" }])));
    assert.equal(text, "ask &lt;!channel&gt; &amp; co");
  });

  it("renders a user mention as a real, notifying mention", () => {
    const text = renderRichText(block(section([{ type: "user", user_id: "U_NUKI" }])));
    assert.equal(text, "<@U_NUKI>");
  });

  it("renders a usergroup mention as a real subteam mention", () => {
    const text = renderRichText(block(section([{ type: "usergroup", usergroup_id: "S_LIMO" }])));
    assert.equal(text, "<!subteam^S_LIMO>");
  });

  it("interleaves text and mentions in order", () => {
    const text = renderRichText(
      block(
        section([
          { type: "text", text: "ask " },
          { type: "user", user_id: "U_NUKI" },
          { type: "text", text: " or " },
          { type: "usergroup", usergroup_id: "S_LIMO" },
        ]),
      ),
    );
    assert.equal(text, "ask <@U_NUKI> or <!subteam^S_LIMO>");
  });

  it("renders a channel mention and an emoji shortcode", () => {
    const text = renderRichText(
      block(section([{ type: "channel", channel_id: "C1" }, { type: "emoji", name: "wave" }])),
    );
    assert.equal(text, "<#C1>:wave:");
  });

  it("renders a link, escaping only the display text", () => {
    const withText = renderRichText(
      block(section([{ type: "link", url: "https://example.com", text: "docs" }])),
    );
    assert.equal(withText, "<https://example.com|docs>");

    const bare = renderRichText(block(section([{ type: "link", url: "https://example.com" }])));
    assert.equal(bare, "<https://example.com>");
  });

  it("keeps a broadcast mention inert, since nobody asked for a mass ping", () => {
    const text = renderRichText(block(section([{ type: "broadcast", range: "channel" }])));
    assert.equal(text, "@channel");
    assert.ok(!text.includes("<!"), "must not become a real broadcast");
  });

  it("flattens a list to its items, joined so they still read as one line", () => {
    const list = renderRichText(
      block({
        type: "rich_text_list",
        style: "bullet",
        elements: [section([{ type: "text", text: "sick" }]), section([{ type: "text", text: "back Thursday" }])],
      }),
    );
    assert.equal(list, "sick; back Thursday");
  });

  it("joins multiple top-level sections with a newline, preserving line breaks", () => {
    const text = renderRichText(
      block(section([{ type: "text", text: "sick" }]), section([{ type: "text", text: "back tomorrow" }])),
    );
    assert.equal(text, "sick\nback tomorrow");
  });
});

describe("parseReasonRichText", () => {
  it("round-trips a plain reason as a single text element", () => {
    assert.deepEqual(parseReasonRichText("sick"), block(section([{ type: "text", text: "sick" }])));
  });

  it("round-trips a real mention as a live user element", () => {
    assert.deepEqual(
      parseReasonRichText("ask <@U_NUKI> first"),
      block(
        section([
          { type: "text", text: "ask " },
          { type: "user", user_id: "U_NUKI" },
          { type: "text", text: " first" },
        ]),
      ),
    );
  });

  it("round-trips a usergroup mention", () => {
    assert.deepEqual(
      parseReasonRichText("ping <!subteam^S_LIMO>"),
      block(
        section([
          { type: "text", text: "ping " },
          { type: "usergroup", usergroup_id: "S_LIMO" },
        ]),
      ),
    );
  });

  it("unescapes a literal text run without double-unescaping it", () => {
    assert.deepEqual(
      parseReasonRichText("ask &lt;!channel&gt; &amp; co"),
      block(section([{ type: "text", text: "ask <!channel> & co" }])),
    );
  });

  it("round-trips whatever renderRichText just produced", () => {
    const original = block(
      section([
        { type: "text", text: "ask <!channel> please, " },
        { type: "user", user_id: "U_NUKI" },
      ]),
    );
    const reason = renderRichText(original);
    assert.deepEqual(parseReasonRichText(reason), original);
  });
});
