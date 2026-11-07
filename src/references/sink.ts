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

/** One record by its file, with the node that names its target and whether `from`'s own annotation holds it. */
interface Named {
  readonly index: number;
  readonly at: Node;
  readonly annotated: boolean;
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
  readonly #declaredAt: (node: Node) => string | undefined;
  readonly #valued = new Map<SourceFile, Valued[]>();
  readonly #named = new Map<SourceFile, Named[]>();
  readonly #held = new Set<string>();

  constructor(
    root: string,
    testFile: (file: SourceFile) => boolean,
    consumer: ConsumerSide | undefined,
    declaredAt: (node: Node) => string | undefined,
  ) {
    this.#root = root;
    this.#testFile = testFile;
    this.#consumer = consumer;
    this.#declaredAt = declaredAt;
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
      if (this.#consumer === undefined && !("column" in at)) {
        const named = this.#named.get(file) ?? [];
        named.push({ index: this.#found.length - 1, at, annotated: this.#annotates(at, from) });
        this.#named.set(file, named);
      }
      if (use === "write" && value !== undefined) {
        const valued = this.#valued.get(file) ?? [];
        valued.push({ index: this.#found.length - 1, value });
        this.#valued.set(file, valued);
      }
    }
  }

  /**
   * Whether a name sits in the annotation of `from`'s own declaration. An annotation holds
   * no block, so the walk stops at the first declaration or block above the name.
   */
  #annotates(name: Node, from: string): boolean {
    if (name.kind === SyntaxKind.SourceFile) {
      return false;
    }
    let child = name;
    let parent = name.parent;
    while (parent.kind !== SyntaxKind.Block && parent.kind !== SyntaxKind.SourceFile) {
      const id = this.#declaredAt(parent);
      if (id !== undefined) {
        return id === from && (parent as { readonly type?: Node }).type === child;
      }
      child = parent;
      parent = parent.parent;
    }
    return false;
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
    for (const [file, named] of this.#named) {
      for (const { index, carriers } of carriersIn(named, this.#valued.get(file) ?? [], found)) {
        const reference = found[index];
        if (reference !== undefined) {
          found[index] = { ...reference, carriers };
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

/**
 * The carriers of each named record of one file: `from` where its own annotation holds the
 * name, then the target of each write whose stored value holds it and that names another
 * declaration, the innermost value first. Values nest or are disjoint.
 */
function carriersIn(
  named: readonly Named[],
  writes: readonly Valued[],
  found: readonly Reference[],
): readonly { index: number; carriers: readonly string[] }[] {
  const byStart = [...named].sort((a, b) => a.at.pos - b.at.pos);
  const holding = new Map<number, Valued[]>();
  for (const write of writes) {
    let low = 0;
    let high = byStart.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((byStart[middle]?.at.pos ?? 0) < write.value.pos) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    for (let at = low; at < byStart.length; at += 1) {
      const one = byStart[at];
      if (one === undefined || one.at.pos >= write.value.end) {
        break;
      }
      if (one.at.end <= write.value.end) {
        holding.set(one.index, [...(holding.get(one.index) ?? []), write]);
      }
    }
  }
  const result: { index: number; carriers: readonly string[] }[] = [];
  for (const one of named) {
    const reference = found[one.index];
    if (reference === undefined) {
      continue;
    }
    const carriers = one.annotated ? [reference.from] : [];
    const values = [...(holding.get(one.index) ?? [])].sort(
      (a, b) => a.value.end - a.value.pos - (b.value.end - b.value.pos),
    );
    for (const write of values) {
      const to = found[write.index]?.to;
      if (to !== undefined && to !== reference.to && !carriers.includes(to)) {
        carriers.push(to);
      }
    }
    if (carriers.length > 0) {
      result.push({ index: one.index, carriers });
    }
  }
  return result;
}
