import type { Finding, FindingDetails, FindingPosition } from "../finding.ts";
import { WORDS, type InventorySymbol } from "../inventory.ts";

/** Where one declaration is written, as a finding carries it. */
export function positionOf(symbol: InventorySymbol): FindingPosition {
  return { ...symbol.position, endLine: Math.max(symbol.position.line, symbol.endLine) };
}

/** The finding one code makes about one declaration of the inventory. */
export function draft(
  code: string,
  symbol: InventorySymbol,
  message: string,
  details?: FindingDetails,
): Finding {
  const position = positionOf(symbol);
  return {
    code,
    position,
    symbol: {
      ref: symbol.ref,
      kind: symbol.kind,
      name: symbol.name,
      sizeLines: position.endLine - position.line + 1,
    },
    message,
    ...(details === undefined ? {} : { details }),
  };
}

/** How a message names one declaration: the reader's word for its kind, and its name. */
export function named(symbol: InventorySymbol): string {
  return `${WORDS[symbol.kind]} ${symbol.name}`;
}

/** The visibility a member's message names, where it narrows the member's reach. */
export function visibilityWord(symbol: InventorySymbol): string {
  switch (symbol.visibility) {
    case "private":
    case "private-name":
      return "private ";
    case "protected":
      return "protected ";
    case "public":
      return "";
  }
}

/** A character an identifier may hold, which a name standing as a whole token has on neither side. */
const IDENTIFIER = /[\p{L}\p{N}_$]/u;

/** The articles a sentence's own nouns follow. */
const ARTICLES = ["a", "an", "the"] as const;

/**
 * Whether a message names its subject as a subject phrase does: `name` as a whole token,
 * inside no longer identifier, selected from nothing and after no article, because a name
 * the sentence's own nouns spell, as "the target", names nothing. A message opens with the
 * word for its subject's kind, so an article opening it is the article whatever the
 * subject is called.
 */
export function namesSubject(message: string, name: string): boolean {
  if (name === "") {
    return false;
  }
  for (let at = message.indexOf(name); at !== -1; at = message.indexOf(name, at + 1)) {
    const before = message.slice(0, at);
    const after = message.charAt(at + name.length);
    const opening = at === 0 && after === " " && (ARTICLES as readonly string[]).includes(name);
    const afterArticle = ARTICLES.some(
      (article) =>
        before.endsWith(`${article} `) &&
        !IDENTIFIER.test(before.charAt(before.length - article.length - 2)),
    );
    if (
      !IDENTIFIER.test(before.charAt(before.length - 1)) &&
      !before.endsWith(".") &&
      !IDENTIFIER.test(after) &&
      !afterArticle &&
      !opening
    ) {
      return true;
    }
  }
  return false;
}
