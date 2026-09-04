import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RichTextBlock, RichTextElement, RichTextSection } from "@slack/types";
import { parseRichText, renderRichText } from "../../src/slack/rich-text.js";

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

  it("carries the toolbar's styling across as mrkdwn markers", () => {
    const styles = [
      [{ bold: true }, "*loud*"],
      [{ italic: true }, "_loud_"],
      [{ strike: true }, "~loud~"],
      [{ code: true }, "`loud`"],
      [{ bold: true, italic: true }, "_*loud*_"],
    ] as const;

    for (const [style, expected] of styles) {
      assert.equal(renderRichText(block(section([{ type: "text", text: "loud", style }]))), expected);
    }
  });

  it("puts a styled run's own padding outside the markers, which mrkdwn needs to render it", () => {
    const text = renderRichText(
      block(section([{ type: "text", text: "loud ", style: { bold: true } }, { type: "text", text: "and clear" }])),
    );
    assert.equal(text, "*loud* and clear");
  });

  it("styles a mention without breaking it", () => {
    const text = renderRichText(
      block(section([{ type: "user", user_id: "U_NUKI", style: { bold: true } }])),
    );
    assert.equal(text, "*<@U_NUKI>*");
  });

  it("gives a list one line per item, since mrkdwn has no list syntax", () => {
    const items = [section([{ type: "text", text: "sick" }]), section([{ type: "text", text: "back Thursday" }])];

    assert.equal(
      renderRichText(block({ type: "rich_text_list", style: "bullet", elements: items })),
      "• sick\n• back Thursday",
    );
    assert.equal(
      renderRichText(block({ type: "rich_text_list", style: "ordered", elements: items })),
      "1. sick\n2. back Thursday",
    );
    assert.equal(
      renderRichText(block({ type: "rich_text_list", style: "bullet", indent: 1, elements: items })),
      "  • sick\n  • back Thursday",
    );
  });

  it("prefixes every line of a quote, and fences preformatted text", () => {
    assert.equal(
      renderRichText(block({ type: "rich_text_quote", elements: [{ type: "text", text: "one\ntwo" }] })),
      "> one\n> two",
    );
    assert.equal(
      renderRichText(block({ type: "rich_text_preformatted", elements: [{ type: "text", text: "npm test" }] })),
      "```\nnpm test\n```",
    );
  });

  it("joins multiple top-level sections with a newline, preserving line breaks", () => {
    const text = renderRichText(
      block(section([{ type: "text", text: "sick" }]), section([{ type: "text", text: "back tomorrow" }])),
    );
    assert.equal(text, "sick\nback tomorrow");
  });
});

describe("parseRichText", () => {
  it("round-trips a plain reason as a single text element", () => {
    assert.deepEqual(parseRichText("sick"), block(section([{ type: "text", text: "sick" }])));
  });

  it("round-trips a real mention as a live user element", () => {
    assert.deepEqual(
      parseRichText("ask <@U_NUKI> first"),
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
      parseRichText("ping <!subteam^S_LIMO>"),
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
      parseRichText("ask &lt;!channel&gt; &amp; co"),
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
    assert.deepEqual(parseRichText(reason), original);
  });

  it("reopens a link, a channel and an emoji as live elements, not escapable text", () => {
    assert.deepEqual(
      parseRichText("see <https://example.com/a-b|example.com/a-b> in <#C1> :wave:"),
      block(
        section([
          { type: "text", text: "see " },
          { type: "link", url: "https://example.com/a-b", text: "example.com/a-b" },
          { type: "text", text: " in " },
          { type: "channel", channel_id: "C1" },
          { type: "text", text: " " },
          { type: "emoji", name: "wave" },
        ]),
      ),
    );
  });

  it("leaves a clock time alone rather than reading :30: as an emoji", () => {
    assert.deepEqual(
      parseRichText("standup 09:30:00"),
      block(section([{ type: "text", text: "standup 09:30:00" }])),
    );
  });

  /**
   * The bodies already in the database are mrkdwn captured from Slack messages.
   * Opening the edit form parses one and submitting re-renders it, so anything
   * that does not survive the pair is a live reminder quietly rewritten.
   */
  describe("the shapes real stored bodies come in", () => {
    const bodies = {
      "meeting link": ":flag-id: *Daily Standup* <https://meet.google.com/abc-defg-hij|meet.google.com/abc-defg-hij>",
      "mentions and indentation":
        ":mega: :mega: *WEB Code Freeze Day* \n\n            \n Hey <@U_ALICE> <@U_BOB> <@U_CARL>,\n            \n :merged: Please share status MR yang ikut *Code Freeze* disini ya.",
      "an escaped ampersand":
        ":rocket: *Sprint Planning &amp; Daily Standup Time!* :rocket:\n:date: Today we have both\n:link: *Join Now:* <https://meet.google.com/abc-defg-hij|meet.google.com/abc-defg-hij>",
      "a usergroup and a bracketed title": ":flag-england: *Daily Standup [English]* <!subteam^S_LIMO>",
    };

    for (const [name, body] of Object.entries(bodies)) {
      it(`re-renders a body with ${name} byte for byte`, () => {
        assert.equal(renderRichText(parseRichText(body)), body);
      });
    }
  });
});
