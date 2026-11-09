import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import fc from "fast-check";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { LOAD_TIMEOUT, partsOf, tsconfigWith } from "../__test-helpers__/intra-function-parts.ts";
import { writeProject } from "../__test-helpers__/projects.ts";

/**
 * One use of the local `x` in an expression: a judged write, a call that reads it, `x += 1`
 * or a call that reads nothing.
 */
interface Atom {
  readonly kind: "write" | "read" | "bump" | "call";
  /** The line the write is rendered on, each judged write on a line of its own. */
  line?: number;
}

/** A condition: `true`, `false`, `c()`, `c(x)`, `!`, parentheses, `&&`, `||`, `??` or `?:`. */
type Test =
  | { readonly kind: "true" | "false" | "call" | "read" }
  | { readonly kind: "not" | "paren"; readonly operand: Test }
  | { readonly kind: "and" | "or" | "coalesce"; readonly left: Test; readonly right: Test }
  | { readonly kind: "ternary"; readonly test: Test; readonly yes: Test; readonly no: Test };

/** The operands of one condition, in the order they are written. */
function operandsOf(one: Test): readonly Test[] {
  switch (one.kind) {
    case "not":
    case "paren":
      return [one.operand];
    case "and":
    case "or":
    case "coalesce":
      return [one.left, one.right];
    case "ternary":
      return [one.test, one.yes, one.no];
    default:
      return [];
  }
}

type Statement =
  | { readonly kind: "expression"; readonly atoms: readonly Atom[] }
  | {
      readonly kind: "if";
      readonly condition: Test;
      readonly then: readonly Statement[];
      readonly otherwise?: readonly Statement[];
    }
  | {
      readonly kind: "while" | "do";
      readonly labels: readonly string[];
      readonly condition: Test;
      readonly body: readonly Statement[];
    }
  | {
      readonly kind: "for";
      readonly labels: readonly string[];
      readonly initializer: readonly Atom[];
      readonly condition?: Test;
      readonly incrementor: readonly Atom[];
      readonly body: readonly Statement[];
    }
  | {
      readonly kind: "for-of";
      readonly labels: readonly string[];
      readonly target?: Atom;
      readonly body: readonly Statement[];
    }
  | { readonly kind: "block"; readonly label?: string; readonly body: readonly Statement[] }
  | {
      readonly kind: "switch";
      readonly clauses: readonly {
        readonly fallback: boolean;
        readonly body: readonly Statement[];
      }[];
    }
  | { readonly kind: "break" | "continue"; readonly label?: string }
  | { readonly kind: "return"; readonly reads: boolean }
  | { readonly kind: "throw" }
  | {
      readonly kind: "try";
      readonly body: readonly Statement[];
      readonly handler?: readonly Statement[];
      readonly final?: readonly Statement[];
    };

/** The jumps a statement may make where it stands. */
interface Scope {
  readonly loop: boolean;
  readonly breakable: boolean;
  readonly labels: readonly string[];
  readonly loopLabels: readonly string[];
  readonly names: { next: number };
}

type Draw = fc.GeneratorValue;

const DEPTH = 3;

function atoms(g: Draw, min: number): Atom[] {
  const count = g(fc.integer, { min, max: 2 });
  return Array.from({ length: count }, () => ({
    kind: g(fc.constantFrom, "write", "write", "read", "bump", "call"),
  }));
}

function labelsOf(g: Draw, scope: Scope): string[] {
  const count = g(fc.integer, { min: 0, max: 2 });
  return Array.from({ length: count }, () => `L${String(scope.names.next++)}`);
}

/** How deep a condition's operators nest. */
const TEST_DEPTH = 3;

function test(g: Draw, depth: number): Test {
  const kind = g(() =>
    fc.constantFrom<Test["kind"]>(
      "true",
      "false",
      "call",
      "read",
      ...(depth < TEST_DEPTH
        ? (["not", "paren", "and", "or", "coalesce", "ternary"] as const)
        : []),
    ),
  );
  switch (kind) {
    case "true":
    case "false":
    case "call":
    case "read":
      return { kind };
    case "not":
    case "paren":
      return { kind, operand: test(g, depth + 1) };
    case "and":
    case "or":
    case "coalesce":
      return { kind, left: test(g, depth + 1), right: test(g, depth + 1) };
    case "ternary":
      return { kind, test: test(g, depth + 1), yes: test(g, depth + 1), no: test(g, depth + 1) };
  }
}

const OPERATORS = { and: "&&", or: "||", coalesce: "??" } as const;

/** A condition's text, each operand that is itself an operator's in parentheses of its own. */
function written(one: Test): string {
  const operand = (inner: Test): string =>
    "left" in inner || inner.kind === "ternary" ? `(${written(inner)})` : written(inner);
  switch (one.kind) {
    case "true":
    case "false":
      return one.kind;
    case "call":
      return "c()";
    case "read":
      return "c(x)";
    case "not":
      return `!${operand(one.operand)}`;
    case "paren":
      return `(${written(one.operand)})`;
    case "and":
    case "or":
    case "coalesce":
      return `${operand(one.left)} ${OPERATORS[one.kind]} ${operand(one.right)}`;
    case "ternary":
      return `${operand(one.test)} ? ${operand(one.yes)} : ${operand(one.no)}`;
  }
}

/**
 * Whether the compiler reports TS2869 in a condition: a `??` whose left operand it knows is
 * never nullish, which below parentheses is a keyword, a `!`, a `??` whose right one is, or a
 * `?:` both of whose branches are.
 */
function refused(one: Test): boolean {
  const never = (inner: Test): boolean =>
    inner.kind === "paren"
      ? never(inner.operand)
      : inner.kind === "coalesce"
        ? never(inner.right)
        : inner.kind === "ternary"
          ? never(inner.yes) && never(inner.no)
          : ["true", "false", "not"].includes(inner.kind);
  return (one.kind === "coalesce" && never(one.left)) || operandsOf(one).some(refused);
}

/** Whether a condition calls `c(x)`, the one that reads the local. */
function mentions(one: Test): boolean {
  return one.kind === "read" || operandsOf(one).some(mentions);
}

function statements(g: Draw, scope: Scope, depth: number): Statement[] {
  const count = g(fc.integer, { min: 0, max: 3 });
  return Array.from({ length: count }, () => statement(g, scope, depth));
}

function statement(
  g: Draw,
  scope: Scope,
  depth: number,
  only?: readonly Statement["kind"][],
): Statement {
  const kinds: readonly Statement["kind"][] = only ?? [
    "expression",
    "expression",
    "return",
    "throw",
    ...(depth < DEPTH
      ? (["if", "while", "do", "for", "for-of", "block", "switch", "try"] as const)
      : []),
    ...(scope.breakable || scope.labels.length > 0 ? (["break"] as const) : []),
    ...(scope.loop ? (["continue"] as const) : []),
  ];
  const kind = g(() => fc.constantFrom(...kinds));
  const inner = (labels: readonly string[], loop: boolean, breakable: boolean): Scope => ({
    loop: scope.loop || loop,
    breakable: scope.breakable || breakable,
    labels: [...scope.labels, ...labels],
    loopLabels: loop ? [...scope.loopLabels, ...labels] : scope.loopLabels,
    names: scope.names,
  });
  const condition = (): Test => test(g, 0);
  switch (kind) {
    case "expression":
      return { kind, atoms: atoms(g, 1) };
    case "return":
      return { kind, reads: g(fc.boolean) };
    case "throw":
      return { kind };
    case "if": {
      const otherwise = g(fc.boolean) ? statements(g, scope, depth + 1) : undefined;
      return {
        kind,
        condition: condition(),
        then: statements(g, scope, depth + 1),
        ...(otherwise === undefined ? {} : { otherwise }),
      };
    }
    case "while":
    case "do": {
      const labels = labelsOf(g, scope);
      return {
        kind,
        labels,
        condition: condition(),
        body: statements(g, inner(labels, true, true), depth + 1),
      };
    }
    case "for": {
      const labels = labelsOf(g, scope);
      return {
        kind,
        labels,
        initializer: atoms(g, 0),
        ...(g(fc.boolean) ? { condition: condition() } : {}),
        incrementor: atoms(g, 0),
        body: statements(g, inner(labels, true, true), depth + 1),
      };
    }
    case "for-of": {
      const labels = labelsOf(g, scope);
      return {
        kind,
        labels,
        ...(g(fc.boolean) ? { target: { kind: "write" as const } } : {}),
        body: statements(g, inner(labels, true, true), depth + 1),
      };
    }
    case "block": {
      const label = g(fc.boolean) ? `L${String(scope.names.next++)}` : undefined;
      const body = statements(
        g,
        inner(label === undefined ? [] : [label], false, false),
        depth + 1,
      );
      return label === undefined ? { kind, body } : { kind, label, body };
    }
    case "switch": {
      const count = g(fc.integer, { min: 0, max: 3 });
      const fallback = g(fc.integer, { min: -1, max: count - 1 });
      return {
        kind,
        clauses: Array.from({ length: count }, (_, at) => ({
          fallback: at === fallback,
          body: statements(g, inner([], false, true), depth + 1),
        })),
      };
    }
    case "try": {
      const shape = g(fc.constantFrom, "catch", "finally", "both");
      return {
        kind,
        body: statements(g, scope, depth + 1),
        ...(shape === "finally" ? {} : { handler: statements(g, scope, depth + 1) }),
        ...(shape === "catch" ? {} : { final: statements(g, scope, depth + 1) }),
      };
    }
    case "break": {
      const targets = [...(scope.breakable ? [undefined] : []), ...scope.labels];
      const label = g(fc.constantFrom, ...targets);
      return label === undefined ? { kind } : { kind, label };
    }
    case "continue": {
      const label = g(fc.constantFrom, undefined, ...scope.loopLabels);
      return label === undefined ? { kind } : { kind, label };
    }
  }
}

/**
 * One loop with a short body inside a `try` whose `catch` or `finally` reads the local, then
 * maybe a write or a read: a throw from the loop's head is the one way some writes are read.
 */
function loopInTry(g: Draw): Statement[] {
  const inside: Scope = {
    loop: true,
    breakable: true,
    labels: [],
    loopLabels: [],
    names: { next: 0 },
  };
  // Half the bodies are empty, since a statement of the body may throw where it starts.
  const body = g(fc.boolean) ? [] : statements(g, inside, DEPTH);
  const kind = g(fc.constantFrom, "for", "for", "while", "do", "for-of");
  const loop: Statement =
    kind === "for"
      ? {
          kind,
          labels: [],
          initializer: atoms(g, 0),
          ...(g(fc.boolean) ? { condition: test(g, 0) } : {}),
          incrementor: atoms(g, 0),
          body,
        }
      : kind === "for-of"
        ? { kind, labels: [], ...(g(fc.boolean) ? { target: { kind: "write" } } : {}), body }
        : { kind, labels: [], condition: test(g, 0), body };
  const read: Statement = { kind: "expression", atoms: [{ kind: "read" }] };
  const shape = g(fc.constantFrom, "catch", "finally", "both");
  const tail = g(fc.constantFrom, "none", "write", "read");
  return [
    {
      kind: "try",
      body: [loop],
      ...(shape === "finally" ? {} : { handler: [read] }),
      ...(shape === "catch" ? {} : { final: [read] }),
    },
    ...(tail === "none" ? [] : [{ kind: "expression" as const, atoms: [{ kind: tail }] }]),
  ];
}

/**
 * A `try` whose block holds only bare blocks, maybe around a write, and whose `catch` reads
 * the local, then maybe a write or a read: no statement of the block may throw, so only the
 * try's entry carries the state before it to the catch.
 */
function tryEntry(g: Draw): Statement[] {
  let body: Statement[] = g(fc.boolean) ? [{ kind: "expression", atoms: [{ kind: "write" }] }] : [];
  for (let depth = g(fc.integer, { min: 0, max: 2 }); depth > 0; depth--) {
    body = [{ kind: "block", body }];
  }
  const read: Statement = { kind: "expression", atoms: [{ kind: "read" }] };
  const tail = g(fc.constantFrom, "none", "write", "write", "read");
  return [
    { kind: "try", body, handler: [read], ...(g(fc.boolean) ? { final: [] } : {}) },
    ...(tail === "none" ? [] : [{ kind: "expression" as const, atoms: [{ kind: tail }] }]),
  ];
}

/**
 * One branch or loop on a generated condition, whose body may write the local, then a read:
 * which ways the condition may go is the one thing that decides the writes.
 */
function branched(g: Draw): Statement[] {
  const condition = test(g, 0);
  const body: Statement[] = g(fc.boolean)
    ? [{ kind: "expression", atoms: [{ kind: "write" }] }]
    : [];
  const kind = g(fc.constantFrom, "if", "while", "do", "for");
  const branch: Statement =
    kind === "if"
      ? { kind, condition, then: body }
      : kind === "for"
        ? { kind, labels: [], initializer: [], condition, incrementor: [], body }
        : { kind, labels: [], condition, body };
  return [branch, { kind: "expression", atoms: [{ kind: "read" }] }];
}

/** Renders one program into `lines`, recording the line of every judged write. */
function render(body: readonly Statement[], indent: string, lines: string[]): void {
  const atom = (one: Atom, at: string, end: string): void => {
    one.line = lines.length + 1;
    const text = { write: "x = 7", read: "use(x)", bump: "x += 1", call: "c()" }[one.kind];
    lines.push(`${at}${text}${end}`);
  };
  const list = (all: readonly Atom[], at: string, end: string): void => {
    all.forEach((one, index) => {
      atom(one, at, index === all.length - 1 ? end : ",");
    });
  };
  const labelled = (labels: readonly string[]): string =>
    labels.map((label) => `${label}: `).join("");
  const nested = (inner: readonly Statement[], open: string, close: string): void => {
    lines.push(open);
    render(inner, `${indent}  `, lines);
    lines.push(close);
  };
  // Pushed before the line the condition is written on, so the comment names that line.
  const test = (condition: Test | undefined): string => {
    if (condition !== undefined && refused(condition)) {
      lines.push(`${indent}// @ts-expect-error`);
    }
    return condition === undefined ? "" : written(condition);
  };
  for (const one of body) {
    switch (one.kind) {
      case "expression":
        list(one.atoms, indent, ";");
        break;
      case "if":
        nested(one.then, `${indent}if (${test(one.condition)}) {`, `${indent}}`);
        if (one.otherwise !== undefined) {
          nested(one.otherwise, `${indent}else {`, `${indent}}`);
        }
        break;
      case "while":
        nested(
          one.body,
          `${indent}${labelled(one.labels)}while (${test(one.condition)}) {`,
          `${indent}}`,
        );
        break;
      case "do":
        lines.push(`${indent}${labelled(one.labels)}do {`);
        render(one.body, `${indent}  `, lines);
        lines.push(`${indent}} while (${test(one.condition)});`);
        break;
      case "for":
        lines.push(`${indent}${labelled(one.labels)}for (`);
        if (one.initializer.length === 0) {
          lines.push(`${indent}  ;`);
        }
        list(one.initializer, `${indent}  `, ";");
        lines.push(`${indent}  ${test(one.condition)};`);
        list(one.incrementor, `${indent}  `, "");
        nested(one.body, `${indent}) {`, `${indent}}`);
        break;
      case "for-of":
        if (one.target === undefined) {
          nested(
            one.body,
            `${indent}${labelled(one.labels)}for (const item of items) {`,
            `${indent}}`,
          );
        } else {
          one.target.line = lines.length + 1;
          nested(one.body, `${indent}${labelled(one.labels)}for (x of items) {`, `${indent}}`);
        }
        break;
      case "block":
        nested(
          one.body,
          `${indent}${one.label === undefined ? "" : `${one.label}: `}{`,
          `${indent}}`,
        );
        break;
      case "switch":
        lines.push(`${indent}switch (n()) {`);
        one.clauses.forEach((clause, at) => {
          lines.push(`${indent}  ${clause.fallback ? "default" : `case ${String(at)}`}:`);
          render(clause.body, `${indent}    `, lines);
        });
        lines.push(`${indent}}`);
        break;
      case "break":
      case "continue":
        lines.push(`${indent}${one.kind}${one.label === undefined ? "" : ` ${one.label}`};`);
        break;
      case "return":
        lines.push(`${indent}return${one.reads ? " use(x)" : ""};`);
        break;
      case "throw":
        lines.push(`${indent}throw new Error("stop");`);
        break;
      case "try":
        nested(one.body, `${indent}try {`, `${indent}}`);
        if (one.handler !== undefined) {
          nested(one.handler, `${indent}catch {`, `${indent}}`);
        }
        if (one.final !== undefined) {
          nested(one.final, `${indent}finally {`, `${indent}}`);
        }
        break;
    }
  }
}

/** What one evaluation of a condition may end in: truthy, falsy and not nullish, nullish, or a throw. */
type Outcome = "yes" | "no" | "nullish" | "throw";

/** Where a keyword or a `?:` stands in a condition, which says whether the compiler knows its value. */
type Place = "condition" | "logical" | "coalesce" | "inner" | "ternary";

/**
 * The oracle's evaluator: every end one condition may come to, by JavaScript's own
 * short-circuit, with each call able to give any value or throw. `knows` says whether the
 * value of a keyword is known where it stands; where it is not, the keyword may go either
 * way, as it may for the compiler, which never makes it nullish or throw. Where `knows`
 * leaves a `?:` unknown, it may also go either way, as the compiler judges it whole.
 */
function outcomes(one: Test, knows: (at: Place) => boolean, at: Place = "condition"): Set<Outcome> {
  const then = (from: Set<Outcome>, more: (end: Outcome) => Iterable<Outcome>): Set<Outcome> =>
    new Set([...from].flatMap((end) => [...more(end)]));
  switch (one.kind) {
    case "true":
    case "false":
      return new Set(knows(at) ? [one.kind === "true" ? "yes" : "no"] : ["yes", "no"]);
    case "call":
    case "read":
      return new Set(["yes", "no", "nullish", "throw"]);
    case "not":
      return then(outcomes(one.operand, knows, "inner"), (end) =>
        end === "throw" ? [end] : [end === "yes" ? "no" : "yes"],
      );
    case "paren":
      return outcomes(one.operand, knows, "inner");
    case "and":
      return then(outcomes(one.left, knows, "logical"), (end) =>
        end === "yes" ? outcomes(one.right, knows, "logical") : [end],
      );
    case "or":
      return then(outcomes(one.left, knows, "logical"), (end) =>
        end === "no" || end === "nullish" ? outcomes(one.right, knows, "logical") : [end],
      );
    case "coalesce":
      return then(outcomes(one.left, knows, "coalesce"), (end) =>
        end === "nullish" ? outcomes(one.right, knows, "coalesce") : [end],
      );
    case "ternary": {
      const ends = then(outcomes(one.test, knows, "condition"), (end) =>
        end === "throw" ? [end] : outcomes(end === "yes" ? one.yes : one.no, knows, "inner"),
      );
      return knows("ternary") ? ends : new Set<Outcome>([...ends, "yes", "no"]);
    }
  }
}

/**
 * Where the compiler knows a keyword's value (`bindCondition`): where it is the whole
 * condition, the condition of a `?:` or an operand of `&&` or `||`. Below `(` or `!` it
 * judges the whole wrapped expression, an operand of `??` it does not fold, and the value of
 * a `?:` it never knows.
 */
const COMPILER = (at: Place): boolean => at === "condition" || at === "logical";

/** Which ways a condition goes on entry for the compiler, and whether it may throw. */
function waysOf(one: Test | undefined): { yes: boolean; no: boolean; throws: boolean } {
  if (one === undefined) {
    return { yes: true, no: false, throws: false };
  }
  const ends = outcomes(one, COMPILER);
  return {
    yes: ends.has("yes"),
    no: ends.has("no") || ends.has("nullish"),
    throws: ends.has("throw"),
  };
}

/** Where each jump of a statement lands in the control-flow graph. */
interface Context {
  readonly exit: number;
  readonly raise: number;
  readonly breaks?: number;
  readonly continues?: number;
  readonly labels: ReadonlyMap<string, { readonly breaks: number; readonly continues?: number }>;
}

/**
 * The oracle: a forward control-flow graph of one program, built independently of the
 * analyzer's backward transfer. A `finally` block is copied once per place it continues to.
 * A throw edge leaves the entry of each `try`, as the compiler's catch sees the state before
 * it, the start of each statement but a bare block, each `c()`, each condition `waysOf`
 * says may throw and each `for…of` head. `x = 7` stores a literal, which cannot throw. A
 * write is dead where no path from it reaches a read before another write or the exit.
 */
function deadWritesOf(body: readonly Statement[], declared: number): number[] {
  const kinds: ("pass" | "read" | "write")[] = [];
  const next: number[][] = [];
  const lines: number[] = [];
  const node = (kind: "pass" | "read" | "write", to: number[], line = 0): number => {
    kinds.push(kind);
    next.push(to);
    lines.push(line);
    return kinds.length - 1;
  };
  const sequence = (all: readonly Statement[], after: number, context: Context): number =>
    all.reduceRight(
      (out, one) =>
        node("pass", [
          step(one, out, context),
          ...(one.kind === "block" && one.label === undefined ? [] : [context.raise]),
        ]),
      after,
    );
  const evaluated = (all: readonly Atom[], after: number, context: Context): number =>
    all.reduceRight(
      (out, one) =>
        ({
          write: () => node("write", [out], one.line ?? 0),
          call: () => node("pass", [out, context.raise]),
          read: () => node("read", []),
          bump: () => node("read", []),
        })[one.kind](),
      after,
    );
  const tested = (
    condition: Test | undefined,
    yes: number,
    no: number,
    context: Context,
  ): number => {
    if (condition !== undefined && mentions(condition)) {
      return node("read", []);
    }
    const way = waysOf(condition);
    return node("pass", [
      ...(way.yes ? [yes] : []),
      ...(way.no ? [no] : []),
      ...(way.throws ? [context.raise] : []),
    ]);
  };
  const looped = (
    context: Context,
    breaks: number,
    continues: number,
    labels: readonly string[],
  ): Context => ({
    ...context,
    breaks,
    continues,
    labels: new Map([
      ...context.labels,
      ...labels.map((label) => [label, { breaks, continues }] as const),
    ]),
  });
  const step = (one: Statement, after: number, context: Context): number => {
    switch (one.kind) {
      case "expression":
        return evaluated(one.atoms, after, context);
      case "if":
        return tested(
          one.condition,
          sequence(one.then, after, context),
          one.otherwise === undefined ? after : sequence(one.otherwise, after, context),
          context,
        );
      case "while": {
        const head = node("pass", []);
        const inside = sequence(one.body, head, looped(context, after, head, one.labels));
        next[head] = [tested(one.condition, inside, after, context)];
        return head;
      }
      case "do": {
        const start = node("pass", []);
        const test = node("pass", []);
        const inside = sequence(one.body, test, looped(context, after, test, one.labels));
        next[test] = [tested(one.condition, inside, after, context)];
        next[start] = [inside];
        return start;
      }
      case "for": {
        const head = node("pass", []);
        const increment = evaluated(one.incrementor, head, context);
        const inside = sequence(one.body, increment, looped(context, after, increment, one.labels));
        next[head] = [tested(one.condition, inside, after, context)];
        return evaluated(one.initializer, head, context);
      }
      case "for-of": {
        const head = node("pass", []);
        const inside = sequence(one.body, head, looped(context, after, head, one.labels));
        const assigned =
          one.target === undefined ? inside : node("write", [inside], one.target.line ?? 0);
        next[head] = [assigned, after, context.raise];
        return head;
      }
      case "block":
        return one.label === undefined
          ? sequence(one.body, after, context)
          : sequence(one.body, after, {
              ...context,
              labels: new Map([...context.labels, [one.label, { breaks: after }]]),
            });
      case "switch": {
        const inside: Context = { ...context, breaks: after };
        const entries: number[] = [];
        let fall = after;
        for (const clause of one.clauses.toReversed()) {
          fall = sequence(clause.body, fall, inside);
          entries.unshift(fall);
        }
        return node(
          "pass",
          one.clauses.some((clause) => clause.fallback) ? entries : [...entries, after],
        );
      }
      case "break":
      case "continue": {
        const target =
          one.label === undefined
            ? one.kind === "break"
              ? context.breaks
              : context.continues
            : one.kind === "break"
              ? context.labels.get(one.label)?.breaks
              : context.labels.get(one.label)?.continues;
        if (target === undefined) {
          throw new Error(`no target for ${one.kind} ${one.label ?? ""}`);
        }
        return node("pass", [target]);
      }
      case "return":
        return one.reads ? node("read", []) : node("pass", [context.exit]);
      case "throw":
        return node("pass", [context.raise]);
      case "try": {
        const copies = new Map<number, number>();
        const final = one.final;
        const through = (target: number): number => {
          if (final === undefined) {
            return target;
          }
          const known = copies.get(target) ?? sequence(final, target, context);
          copies.set(target, known);
          return known;
        };
        const outer: Context = {
          exit: through(context.exit),
          raise: through(context.raise),
          ...(context.breaks === undefined ? {} : { breaks: through(context.breaks) }),
          ...(context.continues === undefined ? {} : { continues: through(context.continues) }),
          labels: new Map(
            [...context.labels].map(([label, jump]) => [
              label,
              {
                breaks: through(jump.breaks),
                ...(jump.continues === undefined ? {} : { continues: through(jump.continues) }),
              },
            ]),
          ),
        };
        const normal = through(after);
        const handler =
          one.handler === undefined ? undefined : sequence(one.handler, normal, outer);
        const raise = handler ?? outer.raise;
        return node("pass", [sequence(one.body, normal, { ...outer, raise }), raise]);
      }
    }
  };
  const exit = node("pass", []);
  const start = sequence(body, exit, { exit, raise: exit, labels: new Map() });
  node("write", [start], declared);
  // A write a copied `finally` holds is one write of the source, live where any copy is.
  const live = new Map<number, boolean>();
  kinds.forEach((kind, write) => {
    if (kind !== "write") {
      return;
    }
    const seen = new Set<number>();
    const pending = [...(next[write] ?? [])];
    let read = false;
    while (pending.length > 0 && !read) {
      const at = pending.pop() ?? exit;
      if (seen.has(at)) {
        continue;
      }
      seen.add(at);
      read = kinds[at] === "read";
      if (kinds[at] === "pass") {
        pending.push(...(next[at] ?? []));
      }
    }
    const line = lines[write] ?? 0;
    live.set(line, (live.get(line) ?? false) || read);
  });
  return [...live]
    .filter(([, read]) => !read)
    .map(([line]) => line)
    .toSorted((a, b) => a - b);
}

/**
 * How many functions one generated file holds, each loaded once with the rest: more for
 * the generators of one short statement, where a function costs little.
 */
const FUNCTIONS = 16;
const SHORT_FUNCTIONS = 48;

/**
 * Asserts, over generated files of `functions` functions each, that the analyzer reports
 * dead the writes the oracle finds dead.
 */
function judged(program: (g: Draw) => Statement[], functions: number): void {
  fc.assert(
    fc.property(fc.gen(), (g) => {
      const lines: string[] = [];
      const expected: number[] = [];
      const controls: string[] = [];
      for (let at = 0; at < functions; at++) {
        const body = program(g);
        lines.push(
          `function f${String(at)}(c: (value?: number) => boolean, use: (value: number) => void, items: readonly number[], n: () => number): void {`,
        );
        // A store that is always dead, whose finding shows the compiler took the function:
        // a function it reports an error in holds no finding.
        lines.push("  let y = 1;");
        controls.push(`DS1404 y src/main.ts:${String(lines.length)}`);
        lines.push("  y = 2;", "  use(y);", "  let x = 0;");
        const declared = lines.length;
        render(body, "  ", lines);
        lines.push("}");
        expected.push(...deadWritesOf(body, declared));
      }
      for (let at = 0; at < functions; at++) {
        lines.push(`f${String(at)}(() => false, () => {}, [], () => 0);`);
      }
      const parts = partsOf(lines);
      const found = parts
        .filter((one) => one.startsWith("DS1404 x "))
        .map((one) => Number(one.slice(one.lastIndexOf(":") + 1)));
      const numbered = lines.map((line, at) => `${String(at + 1)}: ${line}`).join("\n");
      expect(
        parts.filter((one) => one.startsWith("DS1404 y ")),
        numbered,
      ).toEqual(controls);
      expect(found, numbered).toEqual(expected.toSorted((a, b) => a - b));
    }),
    // Each run loads a whole project, so the global thousand runs would take hours.
    {
      numRuns: 100,
      plugins: [fc.interruptAfterTimeLimit(8 * LOAD_TIMEOUT, { failOnInterrupt: true })],
    },
  );
}

describe("the writes to a local the analyzer reports dead", () => {
  it(
    "are the writes from which no path of the program reads the local before writing it again",
    () => {
      judged(
        (g) =>
          statements(
            g,
            { loop: false, breakable: false, labels: [], loopLabels: [], names: { next: 0 } },
            0,
          ),
        FUNCTIONS,
      );
    },
    10 * LOAD_TIMEOUT,
  );

  it(
    "are the writes no way a condition may go carries to a read",
    () => {
      judged(branched, SHORT_FUNCTIONS);
    },
    10 * LOAD_TIMEOUT,
  );

  it(
    "are the writes no throw from a loop's head carries to a catch or a finally that reads them",
    () => {
      judged(loopInTry, SHORT_FUNCTIONS);
    },
    10 * LOAD_TIMEOUT,
  );

  it(
    "are the writes a catch does not read through the entry of a try whose block runs nothing",
    () => {
      judged(tryEntry, SHORT_FUNCTIONS);
    },
    10 * LOAD_TIMEOUT,
  );
});

/** Whether a condition holds a `??`, the one operator whose flow the compiler builds unsoundly. */
function coalesces(one: Test): boolean {
  return one.kind === "coalesce" || operandsOf(one).some(coalesces);
}

/**
 * Where one generated statement stands in its function: alone, inside an IIFE or a class
 * static block with a tail inside and after it, or before a tail an IIFE or a static block
 * holds. The binder walks an IIFE's body and a static block in their statement's flow.
 */
type Wrap = "none" | "iife" | "static" | "into-iife" | "into-static";

/**
 * One statement on a generated condition, rendered into `lines` with `tick()` calls: the
 * lines whose statement no way the condition may go reaches, by the oracle's evaluator with
 * the compiler's knowledge of keywords, and whether the condition holds `??`. A statement
 * inside an unreached one is no line of its own, as one finding covers it.
 */
function unreachedOf(g: Draw, lines: string[]): { unreached: number[]; coalesced: boolean } {
  const condition = test(g, 0);
  const ends = outcomes(condition, COMPILER);
  const yes = ends.has("yes");
  const no = ends.has("no") || ends.has("nullish");
  const wrap: Wrap = g(
    fc.constantFrom,
    "none",
    "none",
    "iife",
    "static",
    "into-iife",
    "into-static",
  );
  const unreached: number[] = [];
  const push = (reached: boolean, line: string): void => {
    lines.push(line);
    if (!reached) {
      unreached.push(lines.length);
    }
  };
  const inner = wrap === "iife" ? "    " : wrap === "static" ? "      " : "  ";
  if (wrap === "iife") {
    lines.push("  (() => {");
  } else if (wrap === "static") {
    lines.push("  class K {", "    static {");
  }
  if (refused(condition)) {
    lines.push(`${inner}// @ts-expect-error`);
  }
  const text = written(condition);
  // Whether control leaves the statement at its end, or through a `return` that ends an IIFE.
  let done = no;
  let returned = false;
  switch (g(fc.constantFrom, "while", "do", "for", "if", "guard")) {
    case "while":
      lines.push(`${inner}while (${text}) {}`);
      break;
    case "do":
      lines.push(`${inner}do {} while (${text});`);
      break;
    case "for":
      lines.push(`${inner}for (; ${text}; ) {}`);
      break;
    case "if":
      lines.push(`${inner}if (${text}) {`);
      push(yes, `${inner}  tick();`);
      lines.push(`${inner}} else {`);
      push(no, `${inner}  tick();`);
      lines.push(`${inner}}`);
      done = true;
      break;
    case "guard":
      lines.push(`${inner}if (${text}) {`);
      push(yes, `${inner}  ${wrap === "static" ? 'throw new Error("stop");' : "return;"}`);
      lines.push(`${inner}}`);
      returned = yes && wrap === "iife";
      break;
  }
  switch (wrap) {
    case "none":
      push(done, "  tick();");
      break;
    case "iife":
    case "static":
      push(done, `${inner}tick();`);
      lines.push(...(wrap === "iife" ? ["  })();"] : ["    }", "  }"]));
      push(done || returned, "  tick();");
      break;
    case "into-iife":
      push(done, "  (() => {");
      lines.push("    tick();", "  })();");
      break;
    case "into-static":
      push(done, "  class K {");
      lines.push("    static {", "      tick();", "    }", "  }");
      break;
  }
  return { unreached, coalesced: coalesces(condition) };
}

/** TS7027, "Unreachable code detected". */
const UNREACHABLE_CODE = 7027;

const MAIN = "/virtual/src/main.ts";

/** The default project's options, under which TS7027 is an error the program reports. */
const ORACLE_OPTIONS: ts.CompilerOptions = {
  strict: true,
  target: ts.ScriptTarget.ESNext,
  noEmit: true,
  allowUnreachableCode: false,
};

const host = ts.createCompilerHost(ORACLE_OPTIONS);
const libraries = new Map<string, ts.SourceFile | undefined>();

/**
 * The first line of each unreachable run tsc 6 reports in one file, less a run inside
 * another, which one finding covers: the cross-check of the analyzer's walk against the
 * compiler's own flow graph.
 */
function compilerUnreached(text: string): number[] {
  const main = ts.createSourceFile(MAIN, text, ts.ScriptTarget.ESNext, true);
  const program = ts.createProgram([MAIN], ORACLE_OPTIONS, {
    ...host,
    fileExists: (name) => name === MAIN || host.fileExists(name),
    getSourceFile: (name, version) => {
      if (name === MAIN) {
        return main;
      }
      if (!libraries.has(name)) {
        libraries.set(name, host.getSourceFile(name, version));
      }
      return libraries.get(name);
    },
  });
  const spans = program
    .getSemanticDiagnostics(main)
    .filter((one) => one.code === UNREACHABLE_CODE)
    .map((one) => ({ start: one.start ?? 0, end: (one.start ?? 0) + (one.length ?? 0) }));
  return spans
    .filter(
      (one) =>
        !spans.some((other) => other !== one && other.start <= one.start && one.end <= other.end),
    )
    .map((one) => main.getLineAndCharacterOfPosition(one.start).line + 1)
    .toSorted((a, b) => a - b);
}

describe("the statements the analyzer reports unreachable", () => {
  it(
    "are statements no way a condition may go reaches, all of them, and the compiler's, where the condition holds no ??",
    () => {
      fc.assert(
        fc.property(fc.gen(), (g) => {
          const lines = ["declare function tick(): void;"];
          const unreached = new Set<number>();
          const certain: number[] = [];
          const checked: { readonly from: number; readonly to: number }[] = [];
          const controls: string[] = [];
          for (let at = 0; at < SHORT_FUNCTIONS; at++) {
            lines.push(
              `function f${String(at)}(c: (value?: number) => boolean, use: (value: number) => void, x: number): void {`,
            );
            const from = lines.length;
            // A store that is always dead, whose finding shows the compiler took the function.
            lines.push("  let y = 1;");
            controls.push(`DS1404 y src/main.ts:${String(lines.length)}`);
            lines.push("  y = 2;", "  use(y);");
            const { unreached: found, coalesced } = unreachedOf(g, lines);
            for (const line of found) {
              unreached.add(line);
            }
            if (!coalesced) {
              certain.push(...found);
              checked.push({ from, to: lines.length });
            }
            lines.push("}");
          }
          for (let at = 0; at < SHORT_FUNCTIONS; at++) {
            lines.push(`f${String(at)}(() => false, () => {}, 0);`);
          }
          const parts = partsOf(lines);
          const reported = parts
            .filter((one) => one.startsWith("DS1405 "))
            .map((one) => Number(one.slice(one.lastIndexOf(":") + 1)));
          const numbered = lines.map((line, at) => `${String(at + 1)}: ${line}`).join("\n");
          const inChecked = (line: number): boolean =>
            checked.some(({ from, to }) => line > from && line <= to);
          expect(
            parts.filter((one) => one.startsWith("DS1404 y ")),
            numbered,
          ).toEqual(controls);
          expect(
            reported.filter((line) => !unreached.has(line)),
            numbered,
          ).toEqual([]);
          expect(
            certain.filter((line) => !reported.includes(line)),
            numbered,
          ).toEqual([]);
          expect(reported.filter(inChecked), numbered).toEqual(
            compilerUnreached(lines.join("\n")).filter(inChecked),
          );
        }),
        {
          numRuns: 100,
          plugins: [fc.interruptAfterTimeLimit(8 * LOAD_TIMEOUT, { failOnInterrupt: true })],
        },
      );
    },
    10 * LOAD_TIMEOUT,
  );
});

/**
 * The callees a generated call names. Some write `never` as their own result, generic or not, or
 * assert their argument. Some do so through a name without an explicit type all along it, an
 * intersection's member or an element access, which the checker does not ask about, and some of
 * those return. The rest return a result a call instantiates to `never`, or infer `never` and throw.
 */
const CALLEES = [
  "function stop(): never {",
  '  throw new Error("stop");',
  "}",
  "function stopWith<T>(reason: T): never {",
  "  throw new Error(String(reason));",
  "}",
  "type Stopped = never;",
  "function stopAliased(): Stopped {",
  '  throw new Error("stop");',
  "}",
  "const stopHeld: () => never = () => {",
  '  throw new Error("stop");',
  "};",
  "const inferred = () => {",
  '  throw new Error("stop");',
  "};",
  "function tap<T>(value: T): T {",
  "  return value;",
  "}",
  "function narrowed<T extends never>(value: T): T {",
  "  return value;",
  "}",
  "function conditional<T>(value: T): T extends never ? never : string {",
  "  return String(value) as T extends never ? never : string;",
  "}",
  "function over(value: string): never;",
  "function over(value: number): number;",
  "function over(value: string | number): number {",
  '  if (typeof value === "string") {',
  "    throw new Error(value);",
  "  }",
  "  return value;",
  "}",
  "class Box<T> {",
  "  constructor(readonly value: T) {}",
  "  get(): T {",
  "    return this.value;",
  "  }",
  "  stop(): never {",
  '    throw new Error("stop");',
  "  }",
  "}",
  "function check(value: unknown): asserts value {",
  "  if (!value) {",
  '    throw new Error("check");',
  "  }",
  "}",
  "const annotated = (): never => 1 as never;",
  "const holder = {",
  "  fail(): never {",
  '    throw new Error("holder");',
  "  },",
  "};",
  "const lying = {",
  "  fail(): never {",
  "    return 1 as never;",
  "  },",
  "};",
  "const typed: { fail(): never } = {",
  "  fail() {",
  '    throw new Error("typed");',
  "  },",
  "};",
  "const both: { stop(): never } & { stop(): number } = Object.assign(",
  "  {},",
  "  {",
  "    stop(): never {",
  '      throw new Error("both");',
  "    },",
  "  },",
  "  { stop: (): number => 0 },",
  ");",
  "const assigned = Object.assign({}, typed, { fail: (): number => 0 });",
  "namespace Ns {",
  "  export function stop(): never {",
  '    throw new Error("ns");',
  "  }",
  "}",
  "class Base {",
  "  stop(): never {",
  '    throw new Error("base");',
  "  }",
  "  static halt(): never {",
  '    throw new Error("halt");',
  "  }",
  "}",
];

/**
 * The call statements a generated function makes, on `nothing: never`, `box: Box<never>` and
 * `maybe: Box<never> | undefined`, which is `undefined` when the function runs.
 */
const CALLS = [
  "stop();",
  'stopWith("why");',
  "stopAliased();",
  "stopHeld();",
  "inferred();",
  "tap(nothing);",
  "tap<never>(nothing);",
  "narrowed(nothing);",
  "conditional<never>(nothing);",
  "conditional(nothing);",
  'over("why");',
  "over(1);",
  "box.get();",
  "box.stop();",
  "maybe?.stop();",
  "check(false);",
  "check(true);",
  "check(c() && false);",
  "annotated();",
  "holder.fail();",
  "lying.fail();",
  "typed.fail();",
  'typed["fail"]();',
  "(stop)();",
  "both.stop();",
  "assigned.fail();",
  "Ns.stop();",
  "Base.halt();",
  "new Base().stop();",
] as const;

/**
 * The calls a generated method of a class that extends `Base` makes through `this` or `super`,
 * and on its own private method through a receiver typed as its subclass or as an intersection.
 */
const METHOD_CALLS = [
  "this.stop();",
  "super.stop();",
  "this.#own();",
  "peer.#own();",
  "mixed.#own();",
] as const;

/** The calls a generated static method of such a class makes. */
const STATIC_CALLS = ["this.halt();", "super.halt();"] as const;

/** The calls the checker lets return, which JavaScript does not. */
const THROWING: ReadonlySet<string> = new Set([
  "inferred();",
  "holder.fail();",
  'typed["fail"]();',
  "new Base().stop();",
  "peer.#own();",
  "mixed.#own();",
]);

describe("the calls the analyzer ends a flow at", () => {
  it(
    "are the compiler's, and no call JavaScript returns from, whatever the call instantiates its callee's result to and however its callee is named",
    () => {
      fc.assert(
        fc.property(fc.gen(), (g) => {
          const lines = [
            "declare function tick(line: number): void;",
            "declare function use(value: unknown): void;",
            ...CALLEES,
          ];
          const tick = (indent: string): void => {
            lines.push(`${indent}tick(${String(lines.length + 1)});`);
          };
          // Whether the function calls a callee the checker lets return, which JavaScript does not.
          let inferring = false;
          let host: "function" | "method" | "static" = "function";
          // Whether the method's `this` parameter types it as the subclass, through which the
          // checker finds no private member.
          let derived = false;
          const call = (indent: string): void => {
            const chosen =
              host === "method"
                ? g(fc.constantFrom, ...CALLS, ...METHOD_CALLS)
                : host === "static"
                  ? g(fc.constantFrom, ...CALLS, ...STATIC_CALLS)
                  : g(fc.constantFrom, ...CALLS);
            inferring ||= THROWING.has(chosen) || (derived && chosen === "this.#own();");
            lines.push(`${indent}${chosen}`);
          };
          const callers: string[] = [];
          const controls: string[] = [];
          const finals: {
            readonly line: number;
            readonly store: string;
            readonly inferring: boolean;
          }[] = [];
          for (let at = 0; at < FUNCTIONS; at++) {
            const list =
              "nothing: never, box: Box<never>, maybe: Box<never> | undefined, c: () => boolean";
            const parameters = `(${list}): void {`;
            host = g(fc.constantFrom, "function", "method", "static");
            derived = host === "method" && g(fc.boolean);
            const name = `H${String(at)}`;
            if (host === "function") {
              lines.push(`function f${String(at)}${parameters}`);
              callers.push(`f${String(at)}`);
            } else if (host === "method") {
              lines.push(
                `class ${name} extends Base {`,
                "  #own(): never {",
                '    throw new Error("own");',
                "  }",
                `  run(${derived ? `this: ${name}Sub, ` : ""}${list}, peer: ${name}Sub = new ${name}Sub(), mixed: ${name} & { tag?: 1 } = new ${name}()): void {`,
              );
              callers.push(`new ${name}Sub().run`);
            } else {
              lines.push(`class ${name} extends Base {`, `  static run${parameters}`);
              callers.push(`${name}.run`);
            }
            // A store that is always dead, whose finding shows the compiler took the function.
            lines.push("  let y = 1;");
            controls.push(`DS1404 y src/main.ts:${String(lines.length)}`);
            lines.push("  y = 2;", "  use(y);", "  let kept = 1;");
            inferring = false;
            const store = `DS1404 kept src/main.ts:${String(lines.length)}`;
            switch (g(fc.constantFrom, "plain", "branch", "caught", "inline", "both")) {
              case "plain":
                call("  ");
                tick("  ");
                break;
              case "branch":
                lines.push("  if (c()) {");
                call("    ");
                tick("    ");
                lines.push("  }");
                break;
              case "caught":
                lines.push("  try {");
                call("    ");
                tick("    ");
                lines.push("  } catch {");
                tick("    ");
                lines.push("  }");
                break;
              case "inline":
                lines.push("  (() => {");
                call("    ");
                tick("    ");
                lines.push("  })();");
                break;
              case "both":
                lines.push("  if (c()) {");
                call("    ");
                lines.push("  } else {");
                call("    ");
                lines.push("  }");
                break;
            }
            tick("  ");
            finals.push({ line: lines.length, store, inferring });
            lines.push("  use(kept);", "}");
            if (host !== "function") {
              lines.push("}");
            }
            if (host === "method") {
              lines.push(`class ${name}Sub extends ${name} {}`);
            }
          }
          const body = lines.join("\n");
          const calls = callers.flatMap((caller) =>
            [true, false].map(
              (value) =>
                `try { ${caller}(undefined as never, new Box(undefined as never), undefined, () => ${String(value)}); } catch {}`,
            ),
          );
          lines.push(...calls);
          const parts = partsOf(lines);
          const ran = new Set<number>();
          runInNewContext(
            ts.transpileModule(`${body}\n${calls.join("\n")}`, {
              compilerOptions: { target: ts.ScriptTarget.ES2022 },
            }).outputText,
            { tick: (line: number) => ran.add(line), use: () => undefined },
          );
          const reported = parts
            .filter((one) => one.startsWith("DS1405 "))
            .map((one) => Number(one.slice(one.lastIndexOf(":") + 1)));
          const numbered = lines.map((line, at) => `${String(at + 1)}: ${line}`).join("\n");
          expect(
            parts.filter((one) => one.startsWith("DS1404 y ")),
            numbered,
          ).toEqual(controls);
          expect(
            reported.filter((line) => ran.has(line) || !/^\s*tick\(/u.test(lines[line - 1] ?? "")),
            numbered,
          ).toEqual([]);
          expect(reported, numbered).toEqual(compilerUnreached(lines.join("\n")));
          expect(
            parts.filter((one) => one.startsWith("DS1404 kept ")),
            numbered,
          ).toEqual(
            finals.filter((one) => !ran.has(one.line) && !one.inferring).map(({ store }) => store),
          );
        }),
        {
          numRuns: 40,
          plugins: [fc.interruptAfterTimeLimit(8 * LOAD_TIMEOUT, { failOnInterrupt: true })],
        },
      );
    },
    10 * LOAD_TIMEOUT,
  );
});

const NATIVE_TSC = join(
  dirname(createRequire(import.meta.url).resolve("@typescript/native/package.json")),
  "bin",
  "tsc",
);

/**
 * The lines the pinned native tsc reports TS7027 at in one file, the oracle where tsc 6 cannot
 * answer: its getTypeOfDottedName has no cycle guard and overflows on loop variables whose
 * iterables name each other.
 */
function nativeUnreached(text: string): number[] {
  const root = writeProject({
    "package.json": '{ "name": "@example/oracle", "private": true, "type": "module" }\n',
    "tsconfig.json": tsconfigWith({ allowUnreachableCode: false }),
    "src/main.ts": `${text}\n`,
  });
  try {
    const { stdout } = spawnSync(process.execPath, [NATIVE_TSC, "-p", ".", "--pretty", "false"], {
      cwd: root,
      encoding: "utf8",
    });
    return [...stdout.matchAll(/^src\/main\.ts\((\d+),\d+\): error TS7027:/gmu)]
      .map((match) => Number(match[1]))
      .toSorted((a, b) => a - b);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * The type a generated loop variable holds: `any` on a cycle of iterables, which the checker
 * cannot type, or what its acyclic iterable holds.
 */
type Held = "any" | "Foo" | "string" | "unknown";

/** The iterables that end an acyclic chain of loop variables, by what their elements hold. */
const TAILS: Readonly<Record<Held, readonly string[]>> = {
  any: [],
  Foo: ["items", "node.list", "node.self.list"],
  string: ["words"],
  unknown: ["unknowns"],
};

/**
 * The narrowings of a loop variable each type admits with no error, and the call each makes on
 * the narrowed variable: `stop` and `self.stop` are a `Foo`'s, `halt` a string's, all `never`.
 */
const NARROWINGS: Readonly<Record<Held, readonly string[]>> = {
  any: ["none", "instanceof", "typeof", "guard", "asserts"],
  Foo: ["none", "instanceof", "guard", "asserts"],
  string: ["none", "typeof"],
  unknown: ["instanceof", "typeof", "guard", "asserts"],
};

describe("the calls through a loop variable the analyzer ends a flow at", () => {
  it(
    "are the native compiler's, on cycles of iterables narrowed by instanceof, typeof, a type guard or an assertion, and on acyclic chains",
    () => {
      fc.assert(
        fc.property(fc.gen(), (g) => {
          const lines = [
            "export {};",
            "declare function tick(): void;",
            "declare function use(value: unknown): void;",
            "declare function isFoo(value: unknown): value is Foo;",
            "declare function assertFoo(value: unknown): asserts value is Foo;",
            "declare global {",
            "  interface String {",
            "    halt(): never;",
            "  }",
            "}",
            "class Foo {",
            "  self: Foo = this;",
            "  list: readonly Foo[] = [];",
            "  stop(): never {",
            '    throw new Error("stop");',
            "  }",
            "}",
          ];
          const controls: string[] = [];
          const stores: { readonly read: number; readonly store: string }[] = [];
          for (let at = 0; at < FUNCTIONS; at++) {
            lines.push(
              `function f${String(at)}(items: readonly Foo[], node: Foo, words: readonly string[], unknowns: readonly unknown[], c: () => boolean): void {`,
            );
            // A store that is always dead, whose finding shows the compiler took the function.
            lines.push("  let y = 1;");
            controls.push(`DS1404 y src/main.ts:${String(lines.length)}`);
            lines.push("  y = 2;", "  use(y);", "  let kept = 1;");
            const store = `DS1404 kept src/main.ts:${String(lines.length)}`;
            // A chain of loop variables v0..v<length - 1>, each iterating the next one's list,
            // the last one closing the cycle back to v0 or iterating a typed tail.
            const length = g(fc.integer, { min: 1, max: 3 });
            const closed = g(fc.boolean);
            const held: Held = closed
              ? "any"
              : length === 1
                ? g(fc.constantFrom, "Foo" as const, "string" as const, "unknown" as const)
                : "Foo";
            const source = (index: number): string =>
              index < length - 1 || closed
                ? `v${String((index + 1) % length)}.${g(fc.constantFrom, "list", "self.list")}`
                : g(fc.constantFrom, ...TAILS[held]);
            const narrowing = g(fc.constantFrom, ...NARROWINGS[held]);
            const member =
              narrowing === "typeof" || (narrowing === "none" && held === "string")
                ? "halt"
                : g(fc.constantFrom, "stop", "self.stop");
            const call = `v0.${member}();`;
            const body = (indent: string): void => {
              const inner = `${indent}  `;
              switch (narrowing) {
                case "none":
                  lines.push(`${indent}${call}`, `${indent}tick();`);
                  break;
                case "asserts":
                  lines.push(`${indent}assertFoo(v0);`, `${indent}${call}`, `${indent}tick();`);
                  break;
                default:
                  lines.push(
                    `${indent}if (${
                      narrowing === "instanceof"
                        ? "v0 instanceof Foo"
                        : narrowing === "typeof"
                          ? 'typeof v0 === "string"'
                          : "isFoo(v0)"
                    }) {`,
                    `${inner}${call}`,
                    `${inner}tick();`,
                    `${indent}}`,
                  );
              }
            };
            const order = Array.from({ length }, (_, index) => index);
            // An acyclic chain nests each loop in the one whose variable it iterates, as a read
            // of a variable a loop may not have assigned is an error (TS2454). A cycle's loops
            // nest the same way or follow one another in any rotation.
            const nested = !closed || g(fc.boolean);
            const first = nested ? 0 : g(fc.integer, { min: 0, max: length - 1 });
            const loops = nested
              ? order.toReversed()
              : [...order.slice(first), ...order.slice(0, first)];
            let depth = 1;
            for (const index of loops) {
              const indent = "  ".repeat(depth);
              const inner = `${indent}  `;
              const innermost = `${inner}  `;
              if (closed) {
                // A function with an error the program reports yields no finding.
                lines.push(
                  `${indent}// @ts-expect-error: a variable on a cycle of iterables is implicitly any (TS7022)`,
                );
              }
              lines.push(`${indent}for (var v${String(index)} of ${source(index)}) {`);
              if (index === 0) {
                switch (g(fc.constantFrom, "plain", "branch", "caught", "inline")) {
                  case "plain":
                    lines.push(`${inner}{`);
                    body(innermost);
                    lines.push(`${inner}}`);
                    break;
                  case "branch":
                    lines.push(`${inner}if (c()) {`);
                    body(innermost);
                    lines.push(`${inner}}`);
                    break;
                  case "caught":
                    lines.push(`${inner}try {`);
                    body(innermost);
                    lines.push(`${inner}} catch {`, `${innermost}tick();`, `${inner}}`);
                    break;
                  case "inline":
                    lines.push(`${inner}(() => {`);
                    body(innermost);
                    lines.push(`${inner}})();`);
                    break;
                }
                lines.push(`${inner}use(kept);`);
                stores.push({ read: lines.length, store });
              }
              if (nested) {
                depth++;
              } else {
                lines.push(`${indent}}`);
              }
            }
            for (; nested && depth > 1; depth--) {
              lines.push(`${"  ".repeat(depth - 1)}}`);
            }
            lines.push("}");
          }
          const parts = partsOf(lines);
          const unreached = nativeUnreached(lines.join("\n"));
          const numbered = lines.map((line, at) => `${String(at + 1)}: ${line}`).join("\n");
          expect(
            parts.filter((one) => one.startsWith("DS1404 y ")),
            numbered,
          ).toEqual(controls);
          expect(
            parts
              .filter((one) => one.startsWith("DS1405 "))
              .map((one) => Number(one.slice(one.lastIndexOf(":") + 1))),
            numbered,
          ).toEqual(unreached);
          // `kept` is read only inside the calling loop, right after the call's own block.
          expect(
            parts.filter((one) => one.startsWith("DS1404 kept ")),
            numbered,
          ).toEqual(
            stores.filter(({ read }) => unreached.includes(read)).map(({ store }) => store),
          );
        }),
        {
          numRuns: 30,
          plugins: [fc.interruptAfterTimeLimit(8 * LOAD_TIMEOUT, { failOnInterrupt: true })],
        },
      );
    },
    10 * LOAD_TIMEOUT,
  );
});

/** Every end the engine itself comes to on one condition, over every value each call may give. */
function engineOutcomes(one: Test): Set<Outcome> {
  const run = runInNewContext(`(c, x) => (${written(one)})`) as (
    c: () => unknown,
    x: number,
  ) => unknown;
  const calls = (inner: Test): number =>
    inner.kind === "call" || inner.kind === "read"
      ? 1
      : operandsOf(inner).reduce((sum, operand) => sum + calls(operand), 0);
  const values = [true, false, null, "throw"] as const;
  const ends = new Set<Outcome>();
  for (let code = 0; code < values.length ** calls(one); code++) {
    let left = code;
    const c = (): unknown => {
      const value = values[left % values.length];
      left = Math.floor(left / values.length);
      if (value === "throw") {
        throw new Error("thrown");
      }
      return value;
    };
    try {
      const value = run(c, 0);
      ends.add(value === null || value === undefined ? "nullish" : value ? "yes" : "no");
    } catch {
      ends.add("throw");
    }
  }
  return ends;
}

const conditions = fc.gen().map((g) => test(g, 0));

describe("the oracle's evaluator of a condition", () => {
  it("comes to the ends the engine comes to where every keyword's value is known", () => {
    fc.assert(
      fc.property(conditions, (one) => {
        expect([...outcomes(one, () => true)].toSorted(), written(one)).toEqual(
          [...engineOutcomes(one)].toSorted(),
        );
      }),
      { numRuns: 300 },
    );
  });

  it("comes to every end the engine comes to where the compiler knows the keywords", () => {
    fc.assert(
      fc.property(conditions, (one) => {
        const compiler = outcomes(one, COMPILER);
        for (const end of engineOutcomes(one)) {
          expect(compiler.has(end), `${written(one)} ${end}`).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });

  const call: Test = { kind: "call" };
  const yes: Test = { kind: "true" };
  const no: Test = { kind: "false" };
  // Each row's ways are tsc 6.0.3's TS7027 answers for its text, apart from the evaluator.
  const TABLE: readonly [Test, boolean, boolean][] = [
    [call, true, true],
    [{ kind: "read" }, true, true],
    [yes, true, false],
    [no, false, true],
    [{ kind: "paren", operand: yes }, true, true],
    [{ kind: "not", operand: no }, true, true],
    [{ kind: "not", operand: { kind: "not", operand: yes } }, true, true],
    [{ kind: "or", left: call, right: yes }, true, false],
    [{ kind: "not", operand: { kind: "and", left: call, right: no } }, true, false],
    [{ kind: "not", operand: { kind: "or", left: yes, right: call } }, false, true],
    [{ kind: "or", left: yes, right: call }, true, false],
    [{ kind: "and", left: no, right: call }, false, true],
    [{ kind: "and", left: yes, right: no }, false, true],
    [{ kind: "and", left: yes, right: yes }, true, false],
    [{ kind: "and", left: yes, right: call }, true, true],
    [{ kind: "coalesce", left: no, right: call }, true, true],
    [{ kind: "ternary", test: call, yes, no: yes }, true, true],
    [{ kind: "ternary", test: yes, yes, no }, true, true],
    [{ kind: "ternary", test: yes, yes: call, no }, true, true],
    [{ kind: "ternary", test: no, yes: call, no: yes }, true, true],
  ];
  it.each(TABLE.map(([one, ...ways]) => [written(one), one, ...ways] as const))(
    "goes the ways tsc gives %s",
    (_, one, ...ways) => {
      const way = waysOf(one);
      expect([way.yes, way.no]).toEqual(ways);
    },
  );
});
