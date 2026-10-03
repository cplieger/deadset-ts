/**
 * The interface-satisfaction class: a class member is held back when a value of the
 * class reaches a position the checker types as an interface requiring a member of
 * that name, so a caller reaches the member through the interface while no name in
 * the program resolves to it.
 *
 * A value reaches such a position as an `implements` entry, the initializer of a
 * declaration whose type is written, an assignment, an argument, a returned value, an
 * array element, an object property, or the operand of `as` or `satisfies`, read
 * through parentheses, conditionals and the operators whose result is an operand.
 * `this` in an instance member is a value of its class. Types are asked in batches;
 * the contextual lookup has none, so it is asked only of a value whose type is a class
 * of the target, and each distinct pair, interface and class is asked once.
 */

import {
  isArrayLiteralExpression,
  isArrowFunction,
  isAsExpression,
  isBinaryExpression,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isClassStaticBlockDeclaration,
  isConditionalExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isHeritageClause,
  isIdentifier,
  isMethodDeclaration,
  isNewExpression,
  isObjectLiteralExpression,
  isParameterDeclaration,
  isParenthesizedExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isReturnStatement,
  isSatisfiesExpression,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSpreadElement,
  isVariableDeclaration,
  ModifierFlags,
  SyntaxKind,
  type Expression,
  type Node,
  type SourceFile,
} from "@typescript/native/unstable/ast";
import { SymbolFlags, type Type } from "@typescript/native/unstable/sync";
import { aliasChains } from "./alias-chain.ts";
import type { DetectorInput, Evidence } from "./exempt.ts";
import { nodeKey } from "./inventory.ts";
import { renderPosition } from "./position.ts";
import { must } from "./query.ts";

/** One class the inventory holds, by its declaration. */
interface ClassAt {
  readonly id: string;
  /** The name node, whose type is the class's instance type. */
  readonly name: Node;
  /** Whether the class declares type parameters, so its values carry instantiations of it. */
  readonly generic: boolean;
}

/** One value that flows into a position the checker types from its context. */
interface Flow {
  readonly value: Expression;
  /** The class `this` stands for, where the value is `this`. */
  readonly self: ClassAt | undefined;
}

/** One entry of a class's `implements` clause. */
interface Clause {
  readonly owner: ClassAt;
  readonly entry: Node;
}

/** One class type reaching one interface type, and the places it does. */
interface Pair {
  readonly owner: ClassAt;
  readonly source: Type;
  readonly target: Type;
  readonly name: string;
  readonly sites: Node[];
}

/** The operators of an assignment whose right side is stored into the left side's type. */
const STORES: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.EqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.AmpersandAmpersandEqualsToken,
]);

/** Whether one node declares a static member, whose `this` is the class itself. */
function isStatic(node: Node): boolean {
  const flags = (node as { readonly modifierFlags?: number }).modifierFlags ?? 0;
  return (flags & ModifierFlags.Static) !== 0;
}

/** Whether one node is a method or an accessor of an object literal, whose `this` is the literal. */
function isObjectLiteralMethod(node: Node): boolean {
  return (
    (isMethodDeclaration(node) ||
      isGetAccessorDeclaration(node) ||
      isSetAccessorDeclaration(node)) &&
    isObjectLiteralExpression(node.parent)
  );
}

/** Whether a declaration writes its type, so its initializer is read in that type's context. */
function writesType(node: Node): boolean {
  return (node as { readonly type?: Node }).type !== undefined;
}

/**
 * The values one written expression hands on: the expression itself, or what it
 * evaluates to through parentheses, a conditional and the operators whose result is
 * one of their operands.
 */
function valuesOf(expression: Expression): readonly Expression[] {
  if (isParenthesizedExpression(expression)) {
    return valuesOf(expression.expression);
  }
  if (isConditionalExpression(expression)) {
    return [...valuesOf(expression.whenTrue), ...valuesOf(expression.whenFalse)];
  }
  if (isBinaryExpression(expression)) {
    const operator = expression.operatorToken.kind;
    if (operator === SyntaxKind.QuestionQuestionToken || operator === SyntaxKind.BarBarToken) {
      return [...valuesOf(expression.left), ...valuesOf(expression.right)];
    }
    if (operator === SyntaxKind.AmpersandAmpersandToken || operator === SyntaxKind.CommaToken) {
      return valuesOf(expression.right);
    }
  }
  return [expression];
}

/** The expressions one node hands to a position typed by its context. */
function handedOn(node: Node): readonly Expression[] {
  if (
    (isVariableDeclaration(node) || isPropertyDeclaration(node) || isParameterDeclaration(node)) &&
    node.initializer !== undefined &&
    writesType(node)
  ) {
    return [node.initializer];
  }
  if (isBinaryExpression(node) && STORES.has(node.operatorToken.kind)) {
    return [node.right];
  }
  if (isCallExpression(node) || isNewExpression(node)) {
    return (node.arguments ?? []).filter((argument) => !isSpreadElement(argument));
  }
  if (isReturnStatement(node)) {
    return node.expression === undefined ? [] : [node.expression];
  }
  if (isArrowFunction(node)) {
    return node.body.kind === SyntaxKind.Block ? [] : [node.body];
  }
  if (isArrayLiteralExpression(node)) {
    return node.elements.filter(
      (element) => !isSpreadElement(element) && element.kind !== SyntaxKind.OmittedExpression,
    );
  }
  if (isPropertyAssignment(node)) {
    return [node.initializer];
  }
  if (isShorthandPropertyAssignment(node)) {
    return isIdentifier(node.name) ? [node.name] : [];
  }
  if (isAsExpression(node) || isSatisfiesExpression(node)) {
    return [node.expression];
  }
  return [];
}

/** What one project's walk found to resolve. */
interface Walked {
  readonly classes: readonly ClassAt[];
  readonly clauses: readonly Clause[];
  readonly flows: readonly Flow[];
}

/**
 * The classes, the `implements` entries and the flowing values of one project's own
 * files. `this` is the class an instance member belongs to, so a function that is not
 * an arrow, a static member and a static block each stop it.
 */
function walk(files: readonly SourceFile[], declarations: ReadonlyMap<string, string>): Walked {
  const classes: ClassAt[] = [];
  const clauses: Clause[] = [];
  const flows: Flow[] = [];
  for (const file of files) {
    const visit = (node: Node, self: ClassAt | undefined): void => {
      let inner = self;
      if (isClassDeclaration(node) || isClassExpression(node)) {
        const id = declarations.get(nodeKey(file, node));
        const name = node.name;
        const owner =
          id === undefined || name === undefined
            ? undefined
            : { id, name, generic: node.typeParameters !== undefined };
        if (owner !== undefined) {
          classes.push(owner);
          for (const clause of node.heritageClauses ?? []) {
            if (isHeritageClause(clause) && clause.token === SyntaxKind.ImplementsKeyword) {
              clauses.push(...clause.types.map((entry) => ({ owner, entry })));
            }
          }
        }
        inner = owner;
      } else if (
        isFunctionDeclaration(node) ||
        isFunctionExpression(node) ||
        isClassStaticBlockDeclaration(node) ||
        isStatic(node) ||
        isObjectLiteralMethod(node)
      ) {
        inner = undefined;
      }
      for (const written of handedOn(node)) {
        for (const value of valuesOf(written)) {
          flows.push({
            value,
            self: value.kind === SyntaxKind.ThisKeyword ? inner : undefined,
          });
        }
      }
      node.forEachChild((child) => {
        visit(child, inner);
      });
    };
    file.forEachChild((child) => {
      visit(child, undefined);
    });
  }
  return { classes, clauses, flows };
}

/**
 * The interface-satisfaction detector: for each class type that reaches an interface
 * type it is assignable to, the class's members whose names the interface's members
 * carry, each recorded at the place the value flows.
 */
export function interfaceSatisfaction<Brand>(input: DetectorInput<Brand>): readonly Evidence[] {
  const { project, held, targetRoot } = input;
  const queries = project.queries;
  const files = project.ownSourceFiles();
  const { classes, clauses, flows } = walk(files, held.declarations);
  if (classes.length === 0) {
    return [];
  }

  // One list, so the batches are capped runs of the whole project rather than of a
  // file: a class's name, an `implements` entry and a value are each one question.
  const asked = [
    ...classes.map((owner) => owner.name),
    ...clauses.map((clause) => clause.entry),
    ...flows.filter((flow) => flow.self === undefined).map((flow) => flow.value),
  ];
  const typeAt = new Map<Node, Type>();
  queries.typesAt(asked).forEach((answer, index) => {
    const type = must(answer);
    const node = asked[index];
    if (type !== undefined && node !== undefined) {
      typeAt.set(node, type);
    }
  });

  const classOfType = new Map<number, ClassAt>();
  const instanceOf = new Map<string, Type>();
  for (const owner of classes) {
    const type = typeAt.get(owner.name);
    if (type !== undefined) {
      classOfType.set(type.id, owner);
      instanceOf.set(owner.id, type);
    }
  }
  const instantiates = classes.some((owner) => owner.generic);

  const constituents = new Map<number, readonly Type[]>();
  const partsOf = (type: Type): readonly Type[] => {
    if (!type.isUnionType() && !type.isIntersectionType()) {
      return [type];
    }
    let parts = constituents.get(type.id);
    if (parts === undefined) {
      parts = must(queries.constituents(type));
      constituents.set(type.id, parts);
    }
    return parts;
  };

  const targets = new Map<number, ClassAt | undefined>();
  /** The classes of the target one value's type is an instance of, with the instance type. */
  const classesOf = (type: Type): readonly { owner: ClassAt; type: Type }[] =>
    partsOf(type).flatMap((part) => {
      const direct = classOfType.get(part.id);
      if (direct !== undefined) {
        return [{ owner: direct, type: part }];
      }
      if (!instantiates || !part.isTypeReference()) {
        return [];
      }
      if (!targets.has(part.id)) {
        targets.set(part.id, classOfType.get(must(queries.targetOf(part)).id));
      }
      const generic = targets.get(part.id);
      return generic === undefined ? [] : [{ owner: generic, type: part }];
    });

  const interfaceNames = new Map<number, string | undefined>();
  /** The interface types one position's type is or holds, each with the interface's name. */
  const interfacesOf = (type: Type): readonly { type: Type; name: string }[] =>
    partsOf(type).flatMap((part) => {
      if (!interfaceNames.has(part.id)) {
        const symbol = part.isObjectType() ? must(queries.symbolOfType(part)) : undefined;
        interfaceNames.set(
          part.id,
          symbol !== undefined && (symbol.flags & SymbolFlags.Interface) !== 0
            ? symbol.name
            : undefined,
        );
      }
      const name = interfaceNames.get(part.id);
      return name === undefined ? [] : [{ type: part, name }];
    });

  const pairs = new Map<string, Pair>();
  const reach = (owner: ClassAt, source: Type, target: Type, name: string, site: Node): void => {
    const key = `${String(source.id)}:${String(target.id)}`;
    const pair = pairs.get(key);
    if (pair === undefined) {
      pairs.set(key, { owner, source, target, name, sites: [site] });
    } else {
      pair.sites.push(site);
    }
  };

  for (const clause of clauses) {
    const source = instanceOf.get(clause.owner.id);
    const target = typeAt.get(clause.entry);
    if (source === undefined || target === undefined) {
      continue;
    }
    for (const reached of interfacesOf(target)) {
      reach(clause.owner, source, reached.type, reached.name, clause.entry);
    }
  }

  // The positions of every flow carrying a class are asked for at once.
  const carrying = flows.flatMap((flow) => {
    const self = flow.self === undefined ? undefined : instanceOf.get(flow.self.id);
    const valueType = typeAt.get(flow.value);
    const sources =
      flow.self !== undefined && self !== undefined
        ? [{ owner: flow.self, type: self }]
        : valueType === undefined
          ? []
          : classesOf(valueType);
    return sources.length === 0 ? [] : [{ flow, sources }];
  });
  const positions = queries.contextualTypes(carrying.map((one) => one.flow.value));
  carrying.forEach(({ flow, sources }, index) => {
    const position = must(positions[index]);
    if (position === undefined) {
      return;
    }
    for (const reached of interfacesOf(position)) {
      for (const source of sources) {
        reach(source.owner, source.type, reached.type, reached.name, flow.value);
      }
    }
  });

  const chains = aliasChains(project, held);
  const required = new Map<number, ReadonlySet<string>>();
  const members = new Map<string, ReadonlyMap<string, readonly string[]>>();
  const found: Evidence[] = [];
  const asking = [...pairs.values()];
  const assignable = queries.assignableEach(asking);
  for (const [index, pair] of asking.entries()) {
    if (!must(assignable[index] ?? false)) {
      continue;
    }
    let names = required.get(pair.target.id);
    if (names === undefined) {
      names = new Set(
        must(queries.propertiesOf(pair.target)).map((property) => property.escapedName),
      );
      required.set(pair.target.id, names);
    }
    let answering = members.get(pair.owner.id);
    if (answering === undefined) {
      const instance = instanceOf.get(pair.owner.id) ?? pair.source;
      answering = new Map(
        must(queries.propertiesOf(instance)).map((property) => [
          property.escapedName,
          chains.declarationsOf(property),
        ]),
      );
      members.set(pair.owner.id, answering);
    }
    const detail = `satisfies ${pair.name}`;
    for (const name of names) {
      for (const id of answering.get(name) ?? []) {
        for (const site of pair.sites) {
          found.push({
            id,
            detail,
            site: renderPosition(site.getSourceFile(), targetRoot, site.getStart()),
          });
        }
      }
    }
  }
  return found;
}
