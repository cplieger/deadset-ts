/**
 * The inline directive: `deadset:ignore`, the first token of a `//` line comment, naming
 * one or more codes and a reason, and binding to every declaration that begins on the line
 * below it, or on its own line where it trails a token there.
 */

import { CODE } from "../contract/contract.generated.ts";
import { SyntaxKind, type Node, type SourceFile } from "@typescript/native/ast";
import type { ImportFact } from "../intra-function-parts.ts";
import type { Inventory } from "../inventory.ts";
import { relativePath } from "../paths.ts";
import {
  byPosition,
  lineEnd,
  positionKey,
  renderPosition,
  tokenStart,
  type Position,
} from "../position.ts";
import type { ProjectView } from "../session.ts";
import {
  isPartKind,
  SuppressionError,
  type Refusal,
  type SuppressionRecord,
  type Suppressions,
} from "./records.ts";

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
      // JSX text carries no trivia: its first code unit is at `pos`, even a `//`.
      const start = node.kind === SyntaxKind.JsxText ? node.pos : tokenStart(text, node.pos);
      spans.push({ start, end: node.end });
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
 * What one placement binds: the declaration a record for a code that reports a
 * declaration binds, and the one a record for a part kind binds, which holds the part.
 * A parameter property's field is the first and its class the second; a constructor's
 * plain parameter binds only the second, because a constructor is no declaration.
 */
interface Binding {
  readonly declared: Declared | undefined;
  readonly part: Declared;
}

function bindingKey(one: Binding): string {
  return `${one.declared?.id ?? ""}\u0000${one.part.id}`;
}

/**
 * The declarations a directive binds, by file path and then by line, as the inventory
 * places them: each on its start lines, and the holder of its parts on its part lines. An
 * import binding is a subject of its own, bound on its statement's lines.
 */
function bindingsByLine(
  held: Inventory,
  symbols: ReadonlyMap<string, Declared>,
  imports: readonly ImportFact[],
): ReadonlyMap<string, ReadonlyMap<number, readonly Binding[]>> {
  const byPath = new Map<string, Map<number, Binding[]>>();
  const add = (path: string, lines: readonly number[], one: Binding): void => {
    const below = byPath.get(path) ?? new Map<number, Binding[]>();
    byPath.set(path, below);
    for (const line of lines) {
      const at = below.get(line) ?? [];
      if (!at.some((known) => bindingKey(known) === bindingKey(one))) {
        at.push(one);
      }
      below.set(line, at);
    }
  };
  for (const [id, placed] of held.placement) {
    const one = symbols.get(id);
    const holder = symbols.get(placed.holder);
    if (one !== undefined && holder !== undefined) {
      add(one.position.path, placed.startLines, { declared: one, part: holder });
      add(one.position.path, placed.partLines, { declared: undefined, part: one });
    }
  }
  for (const binding of imports) {
    const { path, line, column } = binding.position;
    const one = {
      id: positionKey(binding.position),
      ref: binding.ref,
      position: { path, line, column },
    };
    add(path, binding.lines, { declared: one, part: one });
  }
  return byPath;
}

/**
 * Whether the comment at `offset` follows a token on its own line, so it binds the
 * declarations that begin on that line rather than on the next.
 */
function trails(file: SourceFile, offset: number): boolean {
  const { line } = file.getLineAndCharacterOfPosition(offset);
  return tokenStart(file.text, file.getPositionOfLineAndCharacter(line, 0)) < offset;
}

/** One comment in the namespace, what the grammar made of it, and what it bound. */
export interface InlineDirective {
  readonly site: Position;
  readonly text: string;
  readonly directive: Directive;
  readonly bound: Binding[];
}

/**
 * Every comment in the namespace one project's own files hold, each with the declarations
 * it binds, read while the project's view is open.
 */
export function inlineDirectives<Brand>(
  project: ProjectView<Brand>,
  held: Inventory,
  targetRoot: string,
  imports: readonly ImportFact[],
): readonly InlineDirective[] {
  const symbols = new Map<string, Declared>(
    held.symbols
      .filter((symbol) => symbol.kind !== "file")
      .map((symbol) => [symbol.id, { id: symbol.id, ref: symbol.ref, position: symbol.position }]),
  );
  const placed = bindingsByLine(held, symbols, imports);
  const found: InlineDirective[] = [];
  for (const file of project.ownSourceFiles()) {
    const comments = lineComments(file).filter((comment) => CANDIDATE.test(comment.text));
    if (comments.length === 0) {
      continue;
    }
    const below = placed.get(relativePath(targetRoot, file.fileName) ?? "");
    for (const comment of comments) {
      const site = renderPosition(file, targetRoot, comment.offset);
      const target = trails(file, comment.offset) ? site.line : site.line + 1;
      found.push({
        site,
        text: comment.text,
        directive: classifyComment(comment.text),
        bound: [...(below?.get(target) ?? [])],
      });
    }
  }
  return found;
}

/**
 * The inline directives of a run's projects, each bound to the declarations the placement
 * rule gives it, one directive binding the union of what each project holding its file
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
      if (!known.bound.some((other) => bindingKey(other) === bindingKey(one))) {
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
        throw new SuppressionError("inline", site, JSON.stringify(text), DIRECTIVE_FORM);
      case "no-reason":
        for (const code of directive.codes) {
          refusals.push({
            reported: CODE.suppressionWithoutReason,
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
        for (const code of directive.codes) {
          const targets = new Map<string, Declared>();
          for (const one of bound) {
            const target = isPartKind(code) ? one.part : one.declared;
            if (target !== undefined) {
              targets.set(target.id, target);
            }
          }
          const declared = [...targets.values()].sort((a, b) => byPosition(a.position, b.position));
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
