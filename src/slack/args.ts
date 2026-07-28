import { EVERY_DAY, daysColumn, isEveryDay } from "../domain/days.js";
import { fail, ok, type Parsed } from "../domain/result.js";

export interface FlagSpec {
  withValue: readonly string[];
  boolean: readonly string[];
}

export interface Args {
  positionals: string[];
  flags: Map<string, string | true>;
}

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const USER_MENTION = /^<@([UWB][A-Z0-9]+)(?:\|[^>]*)?>$/;

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

function splitFlag(token: string): [string, string | undefined] {
  const body = token.slice(2);
  const equals = body.indexOf("=");
  return equals === -1 ? [body, undefined] : [body.slice(0, equals), body.slice(equals + 1)];
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

export function parseAt(value: string): Parsed<string> {
  return TIME_PATTERN.test(value)
    ? ok(value)
    : fail(`\`${value}\` is not a 24-hour time — use HH:MM, like \`09:00\` or \`16:30\``);
}

/** Day checkboxes from the New Reminder dialog. All seven is `*`, as `--on daily` stores. */
export function daysFromSelection(dayNames: readonly string[]): Parsed<string> {
  if (dayNames.length === 0) return fail("pick at least one day");

  const chosen = new Set(dayNames);
  return ok(isEveryDay(chosen) ? EVERY_DAY : daysColumn(chosen));
}

export function parseDate(value: string): Parsed<string> {
  if (!DATE_PATTERN.test(value)) {
    return fail(`\`${value}\` is not a date — use YYYY-MM-DD, like \`2026-08-17\``);
  }

  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    return fail(`\`${value}\` is not a real date`);
  }

  return ok(value);
}

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
