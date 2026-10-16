/**
 * The members an element access reads by the literal type of its index: `o[k]` with `k`
 * typed `"a" | "b"` reads `a` and `b` of the type of `o`, an index typed `keyof T` reads
 * every member of `T`, and an index typed as a type parameter reads what its constraint does. Where the index is a parameter of a function every call of which the
 * target holds, the members are read at each call, by the type of the argument it passes.
 */

import {
  isArrayLiteralExpression,
  isArrowFunction,
  isBinaryExpression,
  isCallExpression,
  isElementAccessExpression,
  isForInStatement,
  isForOfStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVariableStatement,
  NodeFlags,
  SyntaxKind,
  type CallExpression,
  type ElementAccessExpression,
  type Expression,
  type Identifier,
  type Node,
  type ParameterDeclaration,
  type SourceFile,
} from "@typescript/native/ast";
import type { Type } from "@typescript/native/sync";
import type { AliasChains } from "./alias-chain.ts";
import { nodeKey, type Inventory } from "./inventory.ts";
import { renderPosition } from "./position.ts";
import { UNANSWERED } from "./query.ts";
import type { Reference } from "./references.ts";
import type { ProjectView } from "./session.ts";
import { parenthesesRemoved } from "./unwrap.ts";

type Use = "read" | "write" | "both";

/** The assignment operators that read their target before they write it. */
const COMPOUND: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.PlusEqualsToken,
  SyntaxKind.MinusEqualsToken,
  SyntaxKind.AsteriskEqualsToken,
  SyntaxKind.AsteriskAsteriskEqualsToken,
  SyntaxKind.SlashEqualsToken,
  SyntaxKind.PercentEqualsToken,
  SyntaxKind.LessThanLessThanEqualsToken,
  SyntaxKind.GreaterThanGreaterThanEqualsToken,
  SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  SyntaxKind.AmpersandEqualsToken,
  SyntaxKind.BarEqualsToken,
  SyntaxKind.CaretEqualsToken,
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

/** How an expression is used where it is written: read, written, or both. */
function useOf(node: Node): Use {
  let at = node;
  while (isParenthesizedExpression(at.parent)) {
    at = at.parent;
  }
  const parent = at.parent;
  if (isBinaryExpression(parent) && parent.left === at) {
    if (parent.operatorToken.kind === SyntaxKind.EqualsToken) {
      return "write";
    }
    if (COMPOUND.has(parent.operatorToken.kind)) {
      return "both";
    }
  }
  if (
    (isPrefixUnaryExpression(parent) || isPostfixUnaryExpression(parent)) &&
    (parent.operator === SyntaxKind.PlusPlusToken || parent.operator === SyntaxKind.MinusMinusToken)
  ) {
    return "both";
  }
  return "read";
}

/** Whether an index is a literal the checker resolves to a member by its own text. */
function isLiteralIndex(node: Expression): boolean {
  const at = parenthesesRemoved(node);
  return isStringLiteral(at) || isNumericLiteral(at) || isNoSubstitutionTemplateLiteral(at);
}

/** A function whose calls may decide an access, by the name its calls spell. */
interface Callable {
  readonly name: Identifier;
  readonly parameters: readonly ParameterDeclaration[];
  readonly body: Node | undefined;
}

/**
 * The function `node` is, where every call of it is written in its own file under its own
 * name: a function declaration or a `const` initialized with an arrow function or a function
 * expression, neither exported. A method may be dispatched to through a base class or an
 * interface, so it is none.
 */
function callableOf(node: Node): Callable | undefined {
  const exported = (holder: Node): boolean =>
    ((holder as { readonly modifiers?: readonly Node[] }).modifiers ?? []).some(
      (modifier) =>
        modifier.kind === SyntaxKind.ExportKeyword || modifier.kind === SyntaxKind.DefaultKeyword,
    );
  if (isFunctionDeclaration(node)) {
    return node.name === undefined || exported(node)
      ? undefined
      : { name: node.name, parameters: node.parameters, body: node.body };
  }
  if (!isArrowFunction(node) && !isFunctionExpression(node)) {
    return undefined;
  }
  const declaration = node.parent;
  const list = declaration.parent;
  if (
    !isVariableDeclaration(declaration) ||
    declaration.initializer !== node ||
    !isIdentifier(declaration.name) ||
    !isVariableDeclarationList(list) ||
    (list.flags & NodeFlags.Const) === 0 ||
    !isVariableStatement(list.parent) ||
    exported(list.parent)
  ) {
    return undefined;
  }
  return { name: declaration.name, parameters: node.parameters, body: node.body };
}

/** The innermost function enclosing a node, or none. */
function enclosingFunction(node: Node): Node | undefined {
  for (let at = node.parent as Node | undefined; at !== undefined; at = at.parent) {
    if (
      isFunctionDeclaration(at) ||
      isArrowFunction(at) ||
      isFunctionExpression(at) ||
      at.kind === SyntaxKind.MethodDeclaration ||
      at.kind === SyntaxKind.Constructor ||
      at.kind === SyntaxKind.GetAccessor ||
      at.kind === SyntaxKind.SetAccessor
    ) {
      return at;
    }
  }
  return undefined;
}

/** Whether an assignment target, a destructuring pattern at any depth included, assigns a name. */
function targetAssigns(target: Node, name: string): boolean {
  if (isParenthesizedExpression(target)) {
    return targetAssigns(target.expression, name);
  }
  if (isIdentifier(target)) {
    return target.text === name;
  }
  if (isArrayLiteralExpression(target)) {
    return target.elements.some((element) => targetAssigns(element, name));
  }
  if (isObjectLiteralExpression(target)) {
    return target.properties.some((property) =>
      isPropertyAssignment(property)
        ? targetAssigns(property.initializer, name)
        : isShorthandPropertyAssignment(property)
          ? isIdentifier(property.name) && property.name.text === name
          : isSpreadAssignment(property) && targetAssigns(property.expression, name),
    );
  }
  if (isSpreadElement(target)) {
    return targetAssigns(target.expression, name);
  }
  // A pattern element with a default value, `[k = "a"] = …`, assigns its left side.
  return (
    isBinaryExpression(target) &&
    target.operatorToken.kind === SyntaxKind.EqualsToken &&
    targetAssigns(target.left, name)
  );
}

/**
 * Whether a body assigns a name: by an assignment, a destructuring one included, an
 * increment or a decrement, or as the target of a `for…in` or `for…of` loop.
 */
function assigns(body: Node | undefined, name: string): boolean {
  let found = false;
  const visit = (node: Node): void => {
    if (found) {
      return;
    }
    const target =
      isBinaryExpression(node) &&
      (node.operatorToken.kind === SyntaxKind.EqualsToken || COMPOUND.has(node.operatorToken.kind))
        ? node.left
        : (isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node)) &&
            (node.operator === SyntaxKind.PlusPlusToken ||
              node.operator === SyntaxKind.MinusMinusToken)
          ? node.operand
          : (isForInStatement(node) || isForOfStatement(node)) &&
              node.initializer.kind !== SyntaxKind.VariableDeclarationList
            ? node.initializer
            : undefined;
    found = target !== undefined && targetAssigns(target, name);
    node.forEachChild(visit);
  };
  if (body !== undefined) {
    visit(body);
  }
  return found;
}

/** One lookup: the index whose literal type names members of the object's type, read where and by whom. */
interface Lookup {
  readonly file: SourceFile;
  readonly from: string;
  readonly at: Node;
  readonly object: Expression;
  readonly index: Expression;
  readonly use: Use;
}

/** One access whose index may be a parameter decided at the function's calls. */
interface Candidate {
  readonly file: SourceFile;
  readonly from: string;
  readonly access: ElementAccessExpression;
  readonly use: Use;
}

/**
 * The references the element accesses of one project's own files make to the members their
 * index's literal type names, each made by the declaration holding the access or the call.
 */
export function elementAccessReferences<Brand>(
  project: ProjectView<Brand>,
  held: Inventory,
  chains: AliasChains,
  root: string,
  testFiles: ReadonlySet<string>,
): readonly Reference[] {
  const queries = project.queries;
  const candidates: Candidate[] = [];
  const calls = new Map<Node, { readonly file: SourceFile; readonly from: string }>();
  const names: Identifier[] = [];

  for (const file of project.ownSourceFiles()) {
    const fileId = held.declarations.get(nodeKey(file, file));
    if (fileId === undefined) {
      continue;
    }
    const visit = (node: Node, from: string): void => {
      const holder = held.declarations.get(nodeKey(file, node)) ?? from;
      if (isElementAccessExpression(node) && !isLiteralIndex(node.argumentExpression)) {
        candidates.push({ file, from: holder, access: node, use: useOf(node) });
      }
      if (isCallExpression(node)) {
        calls.set(node, { file, from: holder });
      }
      if (isIdentifier(node)) {
        names.push(node);
      }
      node.forEachChild((child) => {
        visit(child, holder);
      });
    };
    file.forEachChild((child) => {
      visit(child, fileId);
    });
  }
  if (candidates.length === 0) {
    return [];
  }

  // A parameter index is decided at the calls only where the function is a callable every
  // use of which is a call, so the symbols of the parameters and of every name are read.
  const parameterOf = new Map<Candidate, { callable: Callable; at: number }>();
  const byCallable = new Map<Identifier, Candidate[]>();
  for (const candidate of candidates) {
    const index = parenthesesRemoved(candidate.access.argumentExpression);
    const fn = isIdentifier(index) ? enclosingFunction(candidate.access) : undefined;
    const callable = fn === undefined ? undefined : callableOf(fn);
    if (callable === undefined || !isIdentifier(index)) {
      continue;
    }
    const at = callable.parameters.findIndex(
      (parameter) => isIdentifier(parameter.name) && parameter.name.text === index.text,
    );
    if (at < 0 || assigns(callable.body, index.text)) {
      continue;
    }
    parameterOf.set(candidate, { callable, at });
    byCallable.set(callable.name, [...(byCallable.get(callable.name) ?? []), candidate]);
  }
  const callableNames = [...byCallable.keys()];
  const spelled = new Set(callableNames.map((name) => name.text));
  const sameName = names.filter((name) => spelled.has(name.text));
  const symbols = queries.symbolsAt([...callableNames, ...sameName]);
  const symbolOf = new Map<Node, unknown>();
  [...callableNames, ...sameName].forEach((node, at) => {
    const symbol = symbols[at];
    if (symbol !== UNANSWERED && symbol !== undefined) {
      symbolOf.set(node, symbol);
    }
  });
  const callsOf = new Map<Node, CallExpression[] | undefined>();
  for (const name of callableNames) {
    const symbol = symbolOf.get(name);
    let found: CallExpression[] | undefined = symbol === undefined ? undefined : [];
    for (const use of sameName) {
      if (found === undefined) {
        break;
      }
      if (use === name || symbolOf.get(use) !== symbol) {
        continue;
      }
      const parent = use.parent;
      found =
        isCallExpression(parent) && parent.expression === use ? [...found, parent] : undefined;
    }
    callsOf.set(name, found);
  }

  const lookups: Lookup[] = [];
  for (const candidate of candidates) {
    const deferred = parameterOf.get(candidate);
    const sites = deferred === undefined ? undefined : callsOf.get(deferred.callable.name);
    if (deferred === undefined || sites === undefined) {
      lookups.push({
        file: candidate.file,
        from: candidate.from,
        at: candidate.access.argumentExpression,
        object: candidate.access.expression,
        index: candidate.access.argumentExpression,
        use: candidate.use,
      });
      continue;
    }
    // An object that is a parameter too is read as the argument each call passes there.
    const object = parenthesesRemoved(candidate.access.expression);
    const objectAt = isIdentifier(object)
      ? deferred.callable.parameters.findIndex(
          (parameter) => isIdentifier(parameter.name) && parameter.name.text === object.text,
        )
      : -1;
    for (const call of sites) {
      const parameter = deferred.callable.parameters[deferred.at];
      const index = call.arguments[deferred.at] ?? parameter?.initializer;
      const site = calls.get(call);
      if (index === undefined || site === undefined) {
        continue;
      }
      lookups.push({
        file: site.file,
        from: site.from,
        at: call,
        object:
          (objectAt < 0 ? undefined : call.arguments[objectAt]) ?? candidate.access.expression,
        index,
        use: candidate.use,
      });
    }
  }

  const nodes = lookups.flatMap((one) => [one.index, one.object]);
  const types = queries.typesAt(nodes);
  const typeOf = (node: Node, at: number): Type | undefined => {
    const type = types[at];
    return nodes[at] === node && type !== UNANSWERED ? type : undefined;
  };
  // A type parameter's body serves every instantiation, so it reads what its constraint admits.
  const keysOf = (type: Type): Type => {
    if (!type.isTypeParameter()) {
      return type;
    }
    const constraint = queries.constraintOf(type);
    return constraint === UNANSWERED || constraint === undefined ? type : constraint;
  };
  const partsOf = (type: Type): readonly Type[] => {
    const parts = queries.constituents(type);
    return parts === UNANSWERED ? [type] : parts;
  };

  const found: Reference[] = [];
  lookups.forEach((lookup, at) => {
    const indexType = typeOf(lookup.index, 2 * at);
    const objectType = typeOf(lookup.object, 2 * at + 1);
    const literals = indexType === undefined ? undefined : literalNames(partsOf(keysOf(indexType)));
    if (objectType === undefined || literals === undefined) {
      return;
    }
    const position = renderPosition(lookup.file, root, lookup.at.getStart());
    for (const part of partsOf(objectType)) {
      const properties = queries.propertiesOf(part);
      for (const property of properties === UNANSWERED ? [] : properties) {
        if (!literals.has(property.escapedName)) {
          continue;
        }
        for (const to of chains.declarationsOf(property)) {
          for (const use of lookup.use === "both" ? (["read", "write"] as const) : [lookup.use]) {
            found.push({
              from: lookup.from,
              to,
              position,
              use,
              resolution: "keyed",
              test: testFiles.has(position.path),
            });
          }
        }
      }
    }
  });
  return found;
}

/** The names a union of literal types spells, or none where a constituent is no string or number literal. */
function literalNames(parts: readonly Type[]): ReadonlySet<string> | undefined {
  const names = new Set<string>();
  for (const part of parts) {
    if (part.isStringLiteralType()) {
      names.add(part.value);
    } else if (part.isNumberLiteralType()) {
      names.add(String(part.value));
    } else {
      return undefined;
    }
  }
  return names;
}
