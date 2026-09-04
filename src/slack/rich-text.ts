import type {
  RichTextBlock,
  RichTextBlockElement,
  RichTextElement,
  RichTextList,
  RichTextText,
} from "@slack/types";
import { escapeMrkdwn } from "./blocks.js";
import { mention } from "./text.js";

const usergroupMention = (id: string): string => `<!subteam^${id}>`;

type RichTextStyle = NonNullable<RichTextText["style"]>;

/** `underline` is left out: mrkdwn has no marker for it. */
const STYLE_MARKERS: readonly (readonly [keyof RichTextStyle, string])[] = [
  ["code", "`"],
  ["bold", "*"],
  ["italic", "_"],
  ["strike", "~"],
];

const PADDED = /^(\s*)([\s\S]*?)(\s*)$/;

/** mrkdwn ignores a marker that hugs whitespace — `*bold *` renders as literal
 *  asterisks — so a run's own padding moves outside the markers. */
function styled(rendered: string, style: RichTextStyle | undefined): string {
  const markers = STYLE_MARKERS.filter(([name]) => style?.[name]).map(([, marker]) => marker);
  if (markers.length === 0) return rendered;

  const [, before = "", core = "", after = ""] = PADDED.exec(rendered) ?? [];
  if (core === "") return rendered;

  return before + markers.reduce((text, marker) => marker + text + marker, core) + after;
}

function renderContent(element: RichTextElement): string {
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

function renderElement(element: RichTextElement): string {
  return styled(renderContent(element), element.style);
}

function renderElements(elements: readonly RichTextElement[]): string {
  return elements.map(renderElement).join("");
}

const LIST_INDENT = "  ";

const marker = (list: RichTextList, index: number): string =>
  list.style === "ordered" ? `${index + 1}. ` : "• ";

/** mrkdwn has no list syntax, so a list becomes one prefixed line per item. */
function renderList(list: RichTextList): string {
  const indent = LIST_INDENT.repeat(list.indent ?? 0);
  return list.elements
    .map((item, index) => `${indent}${marker(list, index)}${renderElements(item.elements)}`)
    .join("\n");
}

const quote = (text: string): string =>
  text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

function renderBlockElement(element: RichTextBlockElement): string {
  switch (element.type) {
    case "rich_text_list":
      return renderList(element);
    case "rich_text_quote":
      return quote(renderElements(element.elements));
    case "rich_text_preformatted":
      return `\`\`\`\n${renderElements(element.elements)}\n\`\`\``;
    case "rich_text_section":
      return renderElements(element.elements);
  }
}

/**
 * Flattens a submitted rich-text value into one mrkdwn-ready string — escaped
 * literal text, real `<@user>`/`<!subteam^id>` mentions and links, and the
 * toolbar's styling as mrkdwn markers — so callers can splice it straight into
 * a message without re-escaping it.
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

/** Alternatives are ordered longest-prefix first: the bare `<…>` link arm would
 *  otherwise swallow `<!subteam^S1>` and `<#C1|general>`. */
const ENTITY_PATTERN =
  /<@(?<user>\w+)>|<!subteam\^(?<usergroup>\w+)>|<!(?<broadcast>channel|here|everyone)>|<#(?<channel>\w+)(?:\|[^>]*)?>|<(?<url>[^>|\s]+)(?:\|(?<label>[^>]*))?>|:(?<emoji>[a-z0-9_+'-]+):/g;

/** A bare `:30:` out of a timestamp is not an emoji, and turning it into one
 *  would show a broken chip where the text was. */
const isEmojiName = (name: string): boolean => !/^\d+$/.test(name);

function entityElement(groups: Record<string, string | undefined>): RichTextElement | undefined {
  if (groups.user) return { type: "user", user_id: groups.user };
  if (groups.usergroup) return { type: "usergroup", usergroup_id: groups.usergroup };
  if (groups.broadcast) {
    return { type: "broadcast", range: groups.broadcast as "channel" | "here" | "everyone" };
  }
  if (groups.channel) return { type: "channel", channel_id: groups.channel };
  if (groups.url) {
    return { type: "link", url: groups.url, ...(groups.label ? { text: groups.label } : {}) };
  }
  if (groups.emoji && isEmojiName(groups.emoji)) return { type: "emoji", name: groups.emoji };
  return undefined;
}

/**
 * Rebuilds a rich-text value from a stored mrkdwn string, so re-opening a form
 * shows mentions, links and emoji as live chips instead of raw `<@id>` text.
 *
 * Every entity `renderRichText` can emit is parsed back, which makes the pair a
 * round trip: opening a form and saving it unchanged rewrites the same string,
 * rather than escaping a captured `<#C1|general>` into literal `&lt;#C1…`. What
 * does not survive is styling — `*bold*` reopens as its literal markers, which
 * still render as bold once saved.
 */
export function parseRichText(text: string): RichTextBlock {
  const elements: RichTextElement[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(ENTITY_PATTERN)) {
    const element = entityElement(match.groups ?? {});
    if (!element) continue;

    const index = match.index;
    if (index > lastIndex) elements.push(textElement(text.slice(lastIndex, index)));
    elements.push(element);
    lastIndex = index + match[0].length;
  }
  if (lastIndex < text.length) elements.push(textElement(text.slice(lastIndex)));

  return { type: "rich_text", elements: [{ type: "rich_text_section", elements }] };
}
