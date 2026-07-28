export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const fail = <T>(error: string): Parsed<T> => ({ ok: false, error });

export interface FlagSpec {
  withValue: readonly string[];
  boolean: readonly string[];
}

export interface Args {
  positionals: string[];
  flags: Map<string, string | true>;
}

export const DAY_ORDER = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

const EVERY_DAY = "*";
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const LABELLED_MENTION = /<@([UWB][A-Z0-9]+)\|[^>]*>/g;
const USER_MENTION = /^<@([UWB][A-Z0-9]+)(?:\|[^>]*)?>$/;

export const CADENCE_FLAGS: ReadonlyMap<string, number> = new Map([
  ["every-1-week", 1],
  ["every-2-week", 2],
  ["every-3-week", 3],
]);

const flagList = (names: Iterable<string>): string =>
  [...names].map((name) => "`--" + name + "`").join(", ");

function tokenize(text: string): Parsed<string[]> {
  const tokens: string[] = [];
  let current = "";
  let quoted = false;
  let started = false;

  for (const char of text) {
    if (char === '"') {
      quoted = !quoted;
      started = true;
    } else if (/\s/.test(char) && !quoted) {
      if (started) tokens.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }

  if (quoted) return fail("unbalanced quote — every `\"` needs a closing `\"`");
  if (started) tokens.push(current);
  return ok(tokens);
}

export function parseArgs(text: string, spec: FlagSpec): Parsed<Args> {
  const tokenized = tokenize(text);
  if (!tokenized.ok) return tokenized;

  const known = new Set([...spec.withValue, ...spec.boolean]);
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  const tokens = tokenized.value;

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;

    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const [name, inlineValue] = splitFlag(token);
    if (!known.has(name)) {
      return fail(`unknown flag \`--${name}\`. Valid flags: ${flagList(known)}`);
    }
    if (flags.has(name)) return fail(`\`--${name}\` given more than once`);

    if (spec.boolean.includes(name)) {
      if (inlineValue !== undefined) return fail(`\`--${name}\` does not take a value`);
      flags.set(name, true);
      continue;
    }

    const value = inlineValue ?? tokens[++index];
    if (value === undefined || value.startsWith("--")) return fail(`\`--${name}\` needs a value`);
    flags.set(name, value);
  }

  return ok({ positionals, flags });
}

function splitFlag(token: string): [string, string | undefined] {
  const body = token.slice(2);
  const equals = body.indexOf("=");
  return equals === -1 ? [body, undefined] : [body.slice(0, equals), body.slice(equals + 1)];
}

export function parseAt(value: string): Parsed<string> {
  return TIME_PATTERN.test(value)
    ? ok(value)
    : fail(`\`${value}\` is not a 24-hour time — use HH:MM, like \`09:00\` or \`16:30\``);
}

export function parseDays(value: string): Parsed<string> {
  if (value === "daily") return ok(EVERY_DAY);

  const names = value.split(",").map((name) => name.trim().toLowerCase());
  const seen = new Set<string>();

  for (const name of names) {
    if (!DAY_ORDER.includes(name as (typeof DAY_ORDER)[number])) {
      return fail(`\`${name}\` is not a day — use \`daily\` or full names: ${DAY_ORDER.join(", ")}`);
    }
    if (seen.has(name)) return fail(`\`${name}\` listed twice`);
    seen.add(name);
  }

  return ok(DAY_ORDER.filter((day) => seen.has(day)).join(","));
}

export function parseDate(value: string): Parsed<string> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return fail(`\`${value}\` is not a date — use YYYY-MM-DD, like \`2026-08-17\``);
  }

  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    return fail(`\`${value}\` is not a real date`);
  }

  return ok(value);
}

export function parseCadence(flags: Map<string, string | true>): Parsed<number> {
  const given = [...CADENCE_FLAGS.keys()].filter((flag) => flags.has(flag));

  if (given.length > 1) return fail(`only one of ${flagList(given)}`);
  return ok(given.length === 0 ? 1 : CADENCE_FLAGS.get(given[0]!)!);
}

/** Slash-command input is one line, so a literal `\n` is how a multi-line message is typed. */
export function unescapeNewlines(value: string): string {
  return value.replaceAll(String.raw`\n`, "\n");
}

/** Slack sends `<@U123|nuki>` when escaping is on; the label stops it rendering as a mention. */
export function normalizeMentions(text: string): string {
  return text.replace(LABELLED_MENTION, "<@$1>");
}

const SLACK_TOKEN = /<[@#!][^>]*>/g;
const CODE_WORDS = 3;
const CODE_MAX_LENGTH = 24;
const CODE_FALLBACK = "reminder";

/**
 * A code slugged from a message's opening words, so the New Reminder dialog can
 * arrive pre-filled with something valid. `taken` are the codes already used in
 * that channel; a collision gets a numeric suffix rather than a failed submit.
 */
export function suggestCode(messageText: string, taken: ReadonlySet<string>): string {
  const words = messageText
    .replace(SLACK_TOKEN, " ")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  // Whole words only, so the slug never ends mid-word or on a stray dash.
  const picked: string[] = [];
  for (const word of words.slice(0, CODE_WORDS)) {
    if ([...picked, word].join("-").length > CODE_MAX_LENGTH) break;
    picked.push(word);
  }

  const base =
    picked.join("-") || words[0]?.slice(0, CODE_MAX_LENGTH) || CODE_FALLBACK;

  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix++;
  return `${base}-${suffix}`;
}

/** Day checkboxes → the `days` column. All seven is `*`, exactly what `--on daily` stores. */
export function daysFromSelection(dayNames: readonly string[]): Parsed<string> {
  if (dayNames.length === 0) return fail("pick at least one day");

  const chosen = new Set(dayNames);
  if (chosen.size === DAY_ORDER.length) return ok(EVERY_DAY);
  return ok(DAY_ORDER.filter((day) => chosen.has(day)).join(","));
}

/**
 * User ids from `@name` tokens, in the order given. A token arriving as plain
 * text means the slash command's escaping is off, so the error says so — that
 * setting is otherwise a silent dead end.
 */
export function parseUserMentions(tokens: readonly string[]): Parsed<string[]> {
  if (tokens.length === 0) return fail("list at least one person, like `@alice @bob`");

  const userIds: string[] = [];
  for (const token of tokens) {
    const match = USER_MENTION.exec(token);
    if (!match) {
      return fail(
        `\`${token}\` is not a person — type \`@name\` and pick them from the autocomplete. ` +
          'If `@name` still lands here as plain text, tick "Escape channels, users, and links" ' +
          "on the `/bee-remind` slash command.",
      );
    }
    if (userIds.includes(match[1]!)) return fail(`<@${match[1]}> is listed twice`);
    userIds.push(match[1]!);
  }

  return ok(userIds);
}
