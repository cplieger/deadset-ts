/**
 * The inline directive: `deadset:ignore`, the first token of a `//` line comment, naming
 * one or more codes and a reason, and binding to every declaration that begins on the line
 * below it.
 */

import { SyntaxKind, type Node, type SourceFile } from "@typescript/native/unstable/ast";
import { nodeKey, type Inventory } from "./inventory.ts";
import { byPosition, positionKey, renderPosition, type Position } from "./position.ts";
import type { ProjectView } from "./session.ts";
import { signatureOf } from "./signatures.ts";
import {
  SUPPRESSION_WITHOUT_REASON,
  SuppressionError,
  siteText,
  type Refusal,
  type SuppressionRecord,
  type Suppressions,
} from "./suppress.ts";

/**
 * The three expressions the grammar applies to the text of each line comment, in this
 * order: a comment in the namespace, a well-formed directive, and a directive that lacks
 * only its reason. A test pins each to the line the grammar page carries.
 */
export const DIRECTIVE_EXPRESSIONS = {
  candidate: String.raw`^//[ \t]*deadset:`,
  wellFormed: String.raw`^//[ \t]*deadset:ignore[ \t]+(?<codes>DS[0-9]{4}(?:,DS[0-9]{4})*)[ \t]+--[ \t]+(?<reason>[^ \t\r\n][^\r\n]*?)[ \t]*$`,
  noReason: String.raw`^//[ \t]*deadset:ignore[ \t]+(?<codes>DS[0-9]{4}(?:,DS[0-9]{4})*)(?:[ \t]+--)?[ \t]*$`,
} as const;

const CANDIDATE = new RegExp(DIRECTIVE_EXPRESSIONS.candidate);
const WELL_FORMED = new RegExp(DIRECTIVE_EXPRESSIONS.wellFormed);
const NO_REASON = new RegExp(DIRECTIVE_EXPRESSIONS.noReason);

/** The form a malformed directive is told to take. */
const DIRECTIVE_FORM = "// deadset:ignore DS0000[,DS0000...] -- <reason>";

/** What the grammar's decision procedure makes of one comment. */
type Directive =
  | { readonly is: "none" }
  | { readonly is: "directive"; readonly codes: readonly string[]; readonly reason: string }
  | { readonly is: "no-reason"; readonly codes: readonly string[] }
  | { readonly is: "malformed" };

/** Applies the grammar's three expressions to the text of one comment, in order. */
export function classifyComment(text: string): Directive {
  if (!CANDIDATE.test(text)) {
    return { is: "none" };
  }
  const groups = WELL_FORMED.exec(text)?.groups;
  if (groups !== undefined) {
    return {
      is: "directive",
      codes: (groups["codes"] ?? "").split(","),
      reason: groups["reason"] ?? "",
    };
  }
  const bare = NO_REASON.exec(text)?.groups;
  if (bare !== undefined) {
    return { is: "no-reason", codes: (bare["codes"] ?? "").split(",") };
  }
  return { is: "malformed" };
}

/** One `//` line comment: the offset of its first solidus, and its text to the end of its line. */
interface LineComment {
  readonly offset: number;
  readonly text: string;
}

/** The literal tokens whose text may hold `//` or `/*` without starting a comment. */
const LITERALS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.StringLiteral,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.TemplateHead,
  SyntaxKind.TemplateMiddle,
  SyntaxKind.TemplateTail,
  SyntaxKind.RegularExpressionLiteral,
  SyntaxKind.JsxText,
]);

/** Whether one character ends a line, under the language's line terminators. */
function endsLine(char: string | undefined): boolean {
  return char === "\n" || char === "\r" || char === "\u2028" || char === "\u2029";
}

/** The offset where the line holding `from` ends. */
function lineEnd(text: string, from: number): number {
  let at = from;
  while (at < text.length && !endsLine(text[at])) {
    at += 1;
  }
  return at;
}

/**
 * The offset of the first token at or after `from`: whitespace, comments and a leading
 * hashbang are trivia.
 */
export function tokenStart(text: string, from: number): number {
  let at = from;
  if (at === 0 && text.startsWith("#!")) {
    at = lineEnd(text, 0);
  }
  for (;;) {
    if (/\s/u.test(text[at] ?? "")) {
      at += 1;
    } else if (text.startsWith("//", at)) {
      at = lineEnd(text, at);
    } else if (text.startsWith("/*", at)) {
      const close = text.indexOf("*/", at + 2);
      at = close < 0 ? text.length : close + 2;
    } else {
      return at;
    }
  }
}

/**
 * Every `//` line comment of one file, in file order. The text between tokens is read as
 * the language reads it: a block comment holds no line comment, and the literal tokens the
 * syntax tree holds are skipped, so a `//` inside a string, a template or a regular
 * expression starts nothing.
 */
function lineComments(file: SourceFile): readonly LineComment[] {
  const text = file.text;
  const spans: { readonly start: number; readonly end: number }[] = [];
  const visit = (node: Node): void => {
    if (LITERALS.has(node.kind)) {
      spans.push({ start: tokenStart(text, node.pos), end: node.end });
    }
    node.forEachChild(visit);
  };
  file.forEachChild(visit);
  spans.sort((a, b) => a.start - b.start);

  const found: LineComment[] = [];
  let next = 0;
  let at = 0;
  while (at < text.length) {
    while (next < spans.length && (spans[next]?.start ?? 0) < at) {
      next += 1;
    }
    const span = spans[next];
    if (span?.start === at) {
      at = Math.max(span.end, at + 1);
    } else if (text.startsWith("//", at)) {
      const end = lineEnd(text, at);
      found.push({ offset: at, text: text.slice(at, end) });
      at = end;
    } else if (text.startsWith("/*", at)) {
      const close = text.indexOf("*/", at + 2);
      at = close < 0 ? text.length : close + 2;
    } else {
      at += 1;
    }
  }
  return found;
}

/** One declaration a directive can bind: its identifier and its reference. */
interface Declared {
  readonly id: string;
  readonly ref: string;
  readonly position: Position;
}

/**
 * The declarations of one file by the line each begins on, the line of its first token: a
 * decorator, a modifier or the keyword. A variable's first token is its statement's
 * keyword, and a variable written on a later line of the statement also begins there. A
 * function also begins, for a directive, on the line of each of its parameters.
 */
function declarationLines(
  file: SourceFile,
  held: Inventory,
  symbols: ReadonlyMap<string, Declared>,
): ReadonlyMap<number, readonly Declared[]> {
  const below = new Map<number, Declared[]>();
  const add = (offset: number, one: Declared): void => {
    const line = file.getLineAndCharacterOfPosition(tokenStart(file.text, offset)).line + 1;
    const at = below.get(line) ?? [];
    if (!at.some((known) => known.id === one.id)) {
      at.push(one);
    }
    below.set(line, at);
  };
  const visit = (node: Node): void => {
    const id = held.declarations.get(nodeKey(file, node));
    const one = id === undefined ? undefined : symbols.get(id);
    if (one !== undefined) {
      add(node.pos, one);
      // A parameter on a later line of a wrapped signature takes its directive on the
      // line above it, inside the parameter list, and the directive binds the function.
      for (const parameter of signatureOf(node)?.parameters ?? []) {
        add(parameter.pos, one);
      }
      const list = node.parent;
      if (
        node.kind === SyntaxKind.VariableDeclaration &&
        list.kind === SyntaxKind.VariableDeclarationList &&
        list.parent.kind === SyntaxKind.VariableStatement
      ) {
        add(list.parent.pos, one);
      }
    }
    node.forEachChild(visit);
  };
  file.forEachChild(visit);
  return below;
}

/** One comment in the namespace, what the grammar made of it, and what it bound. */
export interface InlineDirective {
  readonly site: Position;
  readonly text: string;
  readonly directive: Directive;
  readonly bound: Declared[];
}

/**
 * Every comment in the namespace one project's own files hold, each with the declarations
 * it binds, read while the project's view is open.
 */
export function inlineDirectives<Brand>(
  project: ProjectView<Brand>,
  held: Inventory,
  targetRoot: string,
): readonly InlineDirective[] {
  const symbols = new Map<string, Declared>(
    held.symbols
      .filter((symbol) => symbol.kind !== "file")
      .map((symbol) => [symbol.id, { id: symbol.id, ref: symbol.ref, position: symbol.position }]),
  );
  const found: InlineDirective[] = [];
  for (const file of project.ownSourceFiles()) {
    const comments = lineComments(file).filter((comment) => CANDIDATE.test(comment.text));
    if (comments.length === 0) {
      continue;
    }
    const below = declarationLines(file, held, symbols);
    for (const comment of comments) {
      const site = renderPosition(file, targetRoot, comment.offset);
      found.push({
        site,
        text: comment.text,
        directive: classifyComment(comment.text),
        bound: [...(below.get(site.line + 1) ?? [])],
      });
    }
  }
  return found;
}

/**
 * The inline directives of a run's projects, each bound to the declarations that begin on
 * the line below it, one directive binding the union of what each project holding its file
 * declares there. A directive that lacks only its reason is one {@link Refusal} per code;
 * any other malformed comment in the namespace ends the read with a
 * {@link SuppressionError} naming the first one written.
 */
export function inlineSuppressions(
  perProject: readonly (readonly InlineDirective[])[],
): Suppressions {
  const merged = new Map<string, InlineDirective>();
  for (const written of perProject.flat()) {
    const key = positionKey(written.site);
    const known = merged.get(key);
    if (known === undefined) {
      merged.set(key, { ...written, bound: [...written.bound] });
      continue;
    }
    for (const one of written.bound) {
      if (!known.bound.some((other) => other.id === one.id)) {
        known.bound.push(one);
      }
    }
  }
  const ordered = [...merged.values()].sort((a, b) => byPosition(a.site, b.site));

  const records: SuppressionRecord[] = [];
  const refusals: Refusal[] = [];
  for (const { site, text, directive, bound } of ordered) {
    switch (directive.is) {
      case "none":
        break;
      case "malformed":
        throw new SuppressionError("inline", siteText(site), JSON.stringify(text), DIRECTIVE_FORM);
      case "no-reason":
        for (const code of directive.codes) {
          refusals.push({
            reported: SUPPRESSION_WITHOUT_REASON,
            code,
            symbol: "",
            path: site.path,
            reason: "",
            site,
            mechanism: "inline",
          });
        }
        break;
      case "directive": {
        const declared = [...bound].sort((a, b) => byPosition(a.position, b.position));
        for (const code of directive.codes) {
          const base = {
            code,
            path: site.path,
            reason: directive.reason,
            site,
            mechanism: "inline",
          } as const;
          if (declared.length === 0) {
            records.push({ ...base, symbol: "", bound: "" });
          }
          for (const one of declared) {
            records.push({ ...base, symbol: one.ref, bound: one.id });
          }
        }
        break;
      }
    }
  }
  return { records, refusals };
}
