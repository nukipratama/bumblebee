const CODE_PATTERN = /^[a-z0-9-]+$/;
const SLACK_TOKEN = /<[@#!][^>]*>/g;
const CODE_WORDS = 3;
const CODE_MAX_LENGTH = 24;
const CODE_FALLBACK = "reminder";

export const CODE_RULE = "lowercase letters, numbers or dashes";

export function isReminderCode(value: string): boolean {
  return CODE_PATTERN.test(value);
}

/** A code slugged from a message's opening words, suffixed past anything in `taken`. */
export function suggestCode(messageText: string, taken: ReadonlySet<string>): string {
  const words = messageText
    .replace(SLACK_TOKEN, " ")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  const wholeWords: string[] = [];
  for (const word of words.slice(0, CODE_WORDS)) {
    if ([...wholeWords, word].join("-").length > CODE_MAX_LENGTH) break;
    wholeWords.push(word);
  }

  const base = wholeWords.join("-") || words[0]?.slice(0, CODE_MAX_LENGTH) || CODE_FALLBACK;

  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix++;
  return `${base}-${suffix}`;
}
