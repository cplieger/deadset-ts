import {
  isBinaryExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  SyntaxKind,
  type Node,
  type SourceFile,
} from "@typescript/native/ast";
import { bindingsOf } from "../import-bindings.ts";
import type { Site } from "../index/sites.ts";
import { byPosition, renderPosition, type Position } from "../position.ts";
import type { ConsumerSide, Reference, Resolution, Use } from "../references.ts";
import { bytewise } from "../text/compare.ts";

/** One declaration a use names: `guessed` where only its name answered, `stepped` where an alias chain led to it. */
export interface Target {
  readonly id: string;
  readonly guessed?: boolean;
  readonly stepped?: boolean;
}

/** One write's index among the records, by its file, with the value it stores. */
interface Valued {
  readonly index: number;
  readonly value: Node;
}

/**
 * Where every reference of one pass is made: it renders the position against the side's
 * root, takes the writing file's test class from the file classes, marks a use only a
 * declaration's name answered `guessed` and an alias step's `alias`, tags a consumer's
 * reference with the consumer, and orders the records.
 */
export class Sink {
  readonly #root: string;
  readonly #testFile: (file: SourceFile) => boolean;
  readonly #consumer: ConsumerSide | undefined;
  readonly #found: Reference[] = [];
  readonly #valued = new Map<SourceFile, Valued[]>();
  readonly #held = new Set<string>();

  constructor(
    root: string,
    testFile: (file: SourceFile) => boolean,
    consumer: ConsumerSide | undefined,
  ) {
    this.#root = root;
    this.#testFile = testFile;
    this.#consumer = consumer;
  }

  /** Whether a test file wrote one walked file's uses. */
  isTest(file: SourceFile): boolean {
    return this.#testFile(file);
  }

  /** The position one node of a walked file renders at. */
  position(file: SourceFile, at: Node): Position {
    return renderPosition(file, this.#root, at.getStart());
  }

  /**
   * Records one use of each target, made by `from` at `at` in `file`. A write that stores
   * `value` is remembered for the import bindings only its values use. A `production` use is
   * production code's whoever writes it.
   */
  add(
    file: SourceFile,
    at: Node | Position,
    from: string,
    targets: Iterable<Target | string>,
    use: Use,
    via: Resolution,
    value?: Node,
    production = false,
  ): void {
    const position = "column" in at ? at : this.position(file, at);
    const test = !production && this.#testFile(file);
    for (const one of targets) {
      const target = typeof one === "string" ? { id: one } : one;
      this.#found.push({
        from,
        to: target.id,
        position,
        use,
        resolution: target.guessed === true ? "by-name" : target.stepped === true ? "alias" : via,
        test,
        ...(target.guessed === true ? { guessed: true as const } : {}),
      });
      if (use === "write" && value !== undefined) {
        const valued = this.#valued.get(file) ?? [];
        valued.push({ index: this.#found.length - 1, value });
        this.#valued.set(file, valued);
      }
    }
  }

  /** Holds declarations an unanswered question could have made live, and the one whose read asked it. */
  hold(ids: Iterable<string>): void {
    for (const id of ids) {
      this.#held.add(id);
    }
  }

  /** The records made so far, before {@link finish} orders them. */
  get made(): readonly Reference[] {
    return this.#found;
  }

  /** Appends records another stage derived from these, rendered already. */
  extend(references: readonly Reference[]): void {
    this.#found.push(...references);
  }

  /**
   * The records in position order, then the declaration named, the referencing declaration
   * and the use, each write marked with the import bindings only its values use, and the
   * held declarations. `usesOf` gives each walked file's name sites.
   */
  finish(usesOf: ReadonlyMap<SourceFile, readonly Site[]>): {
    readonly references: readonly Reference[];
    readonly held: readonly string[];
  } {
    const found = this.#found;
    for (const [file, writes] of this.#valued) {
      for (const { index, names } of aloneIn(file, usesOf.get(file) ?? [], writes, found)) {
        const reference = found[index];
        if (reference !== undefined) {
          found[index] = { ...reference, alone: names };
        }
      }
    }
    found.sort(
      (a, b) =>
        byPosition(a.position, b.position) ||
        bytewise(a.to, b.to) ||
        bytewise(a.from, b.from) ||
        bytewise(a.use, b.use),
    );
    const consumer = this.#consumer;
    return {
      references:
        consumer === undefined
          ? found
          : found.map((reference) => ({ ...reference, consumer: consumer.id })),
      held: [...this.#held].sort(bytewise),
    };
  }
}

/** The value one assignment stores through the name it writes, where it is a plain assignment. */
export function storedValue(name: Node): Node | undefined {
  let target: Node = name;
  if (isPropertyAccessExpression(name.parent) && name.parent.name === name) {
    target = name.parent;
  }
  while (isParenthesizedExpression(target.parent)) {
    target = target.parent;
  }
  const parent = target.parent;
  return isBinaryExpression(parent) &&
    parent.operatorToken.kind === SyntaxKind.EqualsToken &&
    parent.left === target
    ? parent.right
    : undefined;
}

/**
 * The import bindings of one file that only the values written into one declaration
 * use, for each write into it. A binding is named by an identifier that spells its
 * local name and is not the member a property access names.
 */
function aloneIn(
  file: SourceFile,
  uses: readonly Site[],
  writes: readonly Valued[],
  found: readonly Reference[],
): readonly { index: number; names: readonly string[] }[] {
  const bindings = new Set(bindingsOf(file).map((binding) => binding.name.text));
  if (bindings.size === 0) {
    return [];
  }
  const occurrences = new Map<string, Node[]>();
  for (const site of uses) {
    const text = site.node.getText();
    const parent = site.node.parent;
    if (!bindings.has(text) || (isPropertyAccessExpression(parent) && parent.name === site.node)) {
      continue;
    }
    if (!occurrences.get(text)?.includes(site.node)) {
      occurrences.set(text, [...(occurrences.get(text) ?? []), site.node]);
    }
  }
  const inside = (node: Node, value: Node): boolean =>
    node.pos >= value.pos && node.end <= value.end;
  const result: { index: number; names: readonly string[] }[] = [];
  for (const write of writes) {
    const to = found[write.index]?.to;
    const sameTarget = writes.filter((one) => found[one.index]?.to === to);
    const names = [...occurrences]
      .filter(
        ([, nodes]) =>
          nodes.some((node) => inside(node, write.value)) &&
          nodes.every((node) => sameTarget.some((one) => inside(node, one.value))),
      )
      .map(([name]) => name)
      .sort(bytewise);
    if (names.length > 0) {
      result.push({ index: write.index, names });
    }
  }
  return result;
}
