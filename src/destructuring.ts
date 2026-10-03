/**
 * The members a destructuring reads. An object pattern reads each property it names
 * from the value it destructures, so the property's name in the pattern is a read of
 * the member the value's type declares under that name, whether the pattern binds it
 * to a local of the same name, renames it, gives it a default or nests a pattern under
 * it. A rest element names no property: what it copies is read where the copy is.
 */

import {
  isArrayLiteralExpression,
  isBinaryExpression,
  isForOfStatement,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isParameterDeclaration,
  isParenthesizedExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isStringLiteral,
  SyntaxKind,
  type BinaryExpression,
  type Node,
} from "@typescript/native/unstable/ast";
import { TypeFlags, type Symbol as TSSymbol, type Type } from "@typescript/native/unstable/sync";
import { isAnswered, UNANSWERED, type Answer } from "./query.ts";
import type { ProjectView } from "./session.ts";

/** One property one object pattern reads. */
export interface PropertyRead {
  /** The pattern, whose destructured value declares the property. */
  readonly pattern: Node;
  /** The property's name as the pattern writes it, which is where the read is written. */
  readonly key: Node;
  /** The property's name. */
  readonly name: string;
}

/** The text a property name spells, or `undefined` for a computed name. */
function nameText(node: Node | undefined): string | undefined {
  if (node === undefined) {
    return undefined;
  }
  if (
    isIdentifier(node) ||
    isStringLiteral(node) ||
    isNoSubstitutionTemplateLiteral(node) ||
    isNumericLiteral(node)
  ) {
    return node.text;
  }
  return undefined;
}

/** The node one expression is written inside, through however many parentheses enclose it. */
function container(node: Node): { readonly child: Node; readonly parent: Node } {
  let child = node;
  while (isParenthesizedExpression(child.parent)) {
    child = child.parent;
  }
  return { child, parent: child.parent };
}

/** The plain assignment one node is the left side of, if it is one. */
function assignmentOf(node: Node, parent: Node): BinaryExpression | undefined {
  return isBinaryExpression(parent) &&
    parent.operatorToken.kind === SyntaxKind.EqualsToken &&
    parent.left === node
    ? parent
    : undefined;
}

/**
 * Whether an object or array literal is a destructuring target rather than a value: the
 * left side of an assignment, the target of a `for…of`, or an element of a literal that
 * is one, with or without a default.
 */
function isDestructuringTarget(literal: Node): boolean {
  const { child, parent } = container(literal);
  if (assignmentOf(child, parent) !== undefined) {
    return true;
  }
  if (isForOfStatement(parent)) {
    return parent.initializer === child;
  }
  return isElement(child, parent);
}

/** Whether one node is an element of a destructuring target: a property's value, or an array element. */
function isElement(child: Node, parent: Node): boolean {
  if (isPropertyAssignment(parent)) {
    return parent.initializer === child && isDestructuringTarget(parent.parent);
  }
  return isArrayLiteralExpression(parent) && isDestructuringTarget(parent);
}

/**
 * Whether an object binding pattern runs: a pattern in the parameter list of a signature
 * with no body, a function type or an overload among them, binds nothing at runtime.
 */
function binds(pattern: Node): boolean {
  let at = pattern.parent;
  while (at.kind === SyntaxKind.BindingElement) {
    at = at.parent.parent;
  }
  if (!isParameterDeclaration(at)) {
    return true;
  }
  return (at.parent as { readonly body?: Node }).body !== undefined;
}

/** The properties one node reads, where it is an object pattern; none otherwise. */
export function propertyReadsOf(node: Node): readonly PropertyRead[] {
  const reads: PropertyRead[] = [];
  if (isObjectBindingPattern(node)) {
    if (!binds(node)) {
      return reads;
    }
    for (const element of node.elements) {
      const key = element.propertyName ?? element.name;
      const name = nameText(key);
      if (element.dotDotDotToken === undefined && key !== undefined && name !== undefined) {
        reads.push({ pattern: node, key, name });
      }
    }
    return reads;
  }
  if (isObjectLiteralExpression(node) && isDestructuringTarget(node)) {
    for (const property of node.properties) {
      if (isShorthandPropertyAssignment(property) || isPropertyAssignment(property)) {
        const name = nameText(property.name);
        if (name !== undefined) {
          reads.push({ pattern: node, key: property.name, name });
        }
      }
    }
  }
  return reads;
}

/** One step from a destructured value to the value a nested target destructures. */
type Step =
  | { readonly kind: "property"; readonly name: string }
  | { readonly kind: "element"; readonly index: number }
  | { readonly kind: "iterated" };

/** Where an assignment target's value comes from: an expression, and the steps into it. */
interface Source {
  readonly expression: Node;
  readonly steps: readonly Step[];
}

/**
 * Where the value one destructuring target receives comes from. The checker answers for
 * a binding pattern's type itself, so this is asked of an assignment target only, whose
 * own type is the literal's rather than the assigned value's. A default does not move
 * the source: `{ a: { b } = fallback }` reads `b` from `a`. A target inside a spread
 * takes the rest of a value and has no source here.
 */
function sourceOf(target: Node): Source | undefined {
  const steps: Step[] = [];
  let at = target;
  for (;;) {
    const { child, parent } = container(at);
    const assignment = assignmentOf(child, parent);
    if (assignment !== undefined) {
      const outer = container(assignment);
      if (!isElement(outer.child, outer.parent)) {
        return { expression: assignment.right, steps: steps.reverse() };
      }
      at = assignment;
      continue;
    }
    if (isForOfStatement(parent) && parent.initializer === child) {
      steps.push({ kind: "iterated" });
      return { expression: parent.expression, steps: steps.reverse() };
    }
    if (isPropertyAssignment(parent) && parent.initializer === child) {
      const name = nameText(parent.name);
      if (name === undefined) {
        return undefined;
      }
      steps.push({ kind: "property", name });
      at = parent.parent;
      continue;
    }
    if (isArrayLiteralExpression(parent)) {
      steps.push({
        kind: "element",
        index: parent.elements.findIndex((element) => element === child),
      });
      at = parent;
      continue;
    }
    return undefined;
  }
}

/** What resolving one project's property reads cost at the client boundary. */
interface DestructuringCost {
  /** Batched type lookups, one per capped run of a file's patterns and assigned values. */
  readonly patternBatches: number;
  /**
   * Per-type lookups: one property table per distinct destructured type, and each step
   * an assignment target takes into its assigned value.
   */
  readonly patternLookups: number;
}

/** Resolves property reads to the symbols the destructured values' types declare. */
interface Destructuring {
  /**
   * The property symbol each read names, in the order given, `undefined` where the
   * destructured value's type declares no property of that name or is not known, and
   * {@link UNANSWERED} where a question about the value's type went unanswered.
   */
  resolve(reads: readonly PropertyRead[]): readonly Answer<TSSymbol | undefined>[];
  readonly cost: DestructuringCost;
}

/** A type along a destructuring, or the mark that a question about it went unanswered. */
type Found = Answer<Type | undefined>;

/**
 * The resolution over one project, its batches capped at `cap`. Property tables are
 * read once per type for the whole project, since one type is destructured in many
 * places and a table answers every name of it.
 */
export function destructuring<Brand>(project: ProjectView<Brand>, cap: number): Destructuring {
  const queries = project.queries;
  const tables = new Map<number, Answer<ReadonlyMap<string, TSSymbol>>>();
  let patternBatches = 0;
  let patternLookups = 0;

  const tableOf = (type: Type): Answer<ReadonlyMap<string, TSSymbol>> => {
    const known = tables.get(type.id);
    if (known !== undefined) {
      return known;
    }
    let table: Answer<ReadonlyMap<string, TSSymbol>> = new Map<string, TSSymbol>();
    if ((type.flags & TypeFlags.AnyOrUnknown) === 0) {
      patternLookups += 1;
      const properties = queries.propertiesOf(type);
      table = isAnswered(properties)
        ? new Map(properties.map((property) => [property.name, property]))
        : UNANSWERED;
    }
    tables.set(type.id, table);
    return table;
  };

  const definedOf = (type: Type): Found => {
    if ((type.flags & TypeFlags.Union) === 0) {
      return type;
    }
    patternLookups += 1;
    return queries.nonNullable(type);
  };

  /**
   * The type one element of an array or tuple value has: a tuple's element at `index`,
   * an array's element type at any index, and `undefined` for a tuple iterated whole.
   */
  const elementOf = (type: Type, index: number | undefined): Found => {
    if (!type.isTypeReference()) {
      return undefined;
    }
    if (type.isTupleType()) {
      if (index === undefined) {
        return undefined;
      }
      patternLookups += 1;
      const elements = queries.typeArguments(type);
      return isAnswered(elements) ? elements[index] : UNANSWERED;
    }
    patternLookups += 1;
    const array = queries.isArray(type);
    if (!isAnswered(array)) {
      return UNANSWERED;
    }
    if (!array) {
      return undefined;
    }
    patternLookups += 1;
    const elements = queries.typeArguments(type);
    return isAnswered(elements) ? elements[0] : UNANSWERED;
  };

  const step = (type: Type, next: Step): Found => {
    const defined = definedOf(type);
    if (defined === undefined || defined === UNANSWERED) {
      return defined;
    }
    if (next.kind === "property") {
      const table = tableOf(defined);
      if (!isAnswered(table)) {
        return UNANSWERED;
      }
      const property = table.get(next.name);
      if (property === undefined) {
        return undefined;
      }
      patternLookups += 1;
      return queries.typeOfSymbol(property);
    }
    return elementOf(defined, next.kind === "element" ? next.index : undefined);
  };

  const resolve = (reads: readonly PropertyRead[]): readonly Answer<TSSymbol | undefined>[] => {
    const patterns = [...new Set(reads.map((read) => read.pattern))];
    const sources = new Map<Node, Source | undefined>();
    const asking = new Set<Node>();
    for (const pattern of patterns) {
      if (isObjectBindingPattern(pattern)) {
        asking.add(pattern);
        continue;
      }
      const source = sourceOf(pattern);
      sources.set(pattern, source);
      if (source !== undefined) {
        asking.add(source.expression);
      }
    }
    const asked = [...asking];
    patternBatches += Math.ceil(asked.length / cap);
    const answered = new Map<Node, Found>();
    queries.typesAt(asked, cap).forEach((type, index) => {
      const node = asked[index];
      if (node !== undefined) {
        answered.set(node, type);
      }
    });
    const patternTypes = new Map<Node, Found>();
    for (const pattern of patterns) {
      const source = sources.get(pattern);
      if (source === undefined) {
        patternTypes.set(pattern, answered.get(pattern));
        continue;
      }
      let type = answered.get(source.expression);
      for (const next of source.steps) {
        type = type === undefined || type === UNANSWERED ? type : step(type, next);
      }
      patternTypes.set(pattern, type === undefined || type === UNANSWERED ? type : definedOf(type));
    }
    return reads.map((read) => {
      const type = patternTypes.get(read.pattern);
      if (type === undefined || type === UNANSWERED) {
        return type;
      }
      const table = tableOf(type);
      return isAnswered(table) ? table.get(read.name) : UNANSWERED;
    });
  };

  return {
    resolve,
    get cost() {
      return { patternBatches, patternLookups };
    },
  };
}
