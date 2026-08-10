import type { RichTextBlock, RichTextBlockElement, RichTextElement, RichTextText } from "@slack/types";
import { escapeMrkdwn } from "./blocks.js";
import { mention } from "./text.js";

const usergroupMention = (id: string): string => `<!subteam^${id}>`;

function renderElement(element: RichTextElement): string {
  switch (element.type) {
    case "text":
      return escapeMrkdwn(element.text);
    case "user":
      return mention(element.user_id);
    case "usergroup":
      return usergroupMention(element.usergroup_id);
    case "channel":
      return `<#${element.channel_id}>`;
    case "emoji":
      return `:${element.name}:`;
    case "link":
      return element.text ? `<${element.url}|${escapeMrkdwn(element.text)}>` : `<${element.url}>`;
    // @here/@channel/@everyone and workspace mentions carry the mass-ping blast
    // radius escapeMrkdwn was built to block, and nobody asked for those — kept inert.
    case "broadcast":
      return `@${element.range}`;
    case "team":
      return "@team";
    case "date":
      return element.fallback ? escapeMrkdwn(element.fallback) : "";
    case "color":
      return escapeMrkdwn(element.value);
  }
}

function renderElements(elements: readonly RichTextElement[]): string {
  return elements.map(renderElement).join("");
}

function renderBlockElement(element: RichTextBlockElement): string {
  switch (element.type) {
    case "rich_text_list":
      return element.elements.map((section) => renderElements(section.elements)).join("; ");
    case "rich_text_section":
    case "rich_text_quote":
    case "rich_text_preformatted":
      return renderElements(element.elements);
  }
}

/**
 * Flattens a submitted rich-text reason into one mrkdwn-ready string — escaped
 * literal text plus real `<@user>`/`<!subteam^id>` mentions — so callers can
 * splice it straight into a message without re-escaping it.
 */
export function renderRichText(block: RichTextBlock): string {
  return block.elements.map(renderBlockElement).join("\n");
}

function textElement(escaped: string): RichTextText {
  return { type: "text", text: unescapeMrkdwn(escaped) };
}

/** Reverses escapeMrkdwn's own replacements in the opposite order it applied
 *  them, so an originally-literal "&lt;" doesn't double-unescape into "<". */
function unescapeMrkdwn(text: string): string {
  return text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

const MENTION_PATTERN = /<@(\w+)>|<!subteam\^(\w+)>/g;

/**
 * Rebuilds a minimal rich-text value from a stored reason, so re-opening the
 * edit modal shows real mentions as live chips again instead of raw `<@id>`
 * text. Only `<@user>`/`<!subteam^id>` round-trip this way — a reason
 * containing a channel mention or emoji reopens as inert text, an accepted gap.
 */
export function parseReasonRichText(reason: string): RichTextBlock {
  const elements: RichTextElement[] = [];
  let lastIndex = 0;

  for (const match of reason.matchAll(MENTION_PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) elements.push(textElement(reason.slice(lastIndex, index)));
    elements.push(
      match[1] ? { type: "user", user_id: match[1] } : { type: "usergroup", usergroup_id: match[2]! },
    );
    lastIndex = index + match[0].length;
  }
  if (lastIndex < reason.length) elements.push(textElement(reason.slice(lastIndex)));

  return { type: "rich_text", elements: [{ type: "rich_text_section", elements }] };
}
