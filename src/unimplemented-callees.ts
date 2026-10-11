/**
 * The members read where code the target cannot see receives a value of a target type. An
 * object literal argument of a call or a `new` whose callee has no implementation in the
 * target has every member of the parameter type it is checked against read, nested
 * literals included. An `as` expression over an object no file of the project declares, and
 * a `new` through an unimplemented construct signature, hand the target a value the
 * outside code holds, so every member of the type it is given is read.
 */

import {
  isArrowFunction,
  isAsExpression,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isHeritageClause,
  isIdentifier,
  isMethodDeclaration,
  isNewExpression,
  isObjectLiteralExpression,
  isParameterDeclaration,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isSatisfiesExpression,
  isTypeReferenceNode,
  isVariableDeclaration,
  type CallExpression,
  type Expression,
  type NewExpression,
  type Node,
  type ObjectLiteralExpression,
  type ParameterDeclaration,
  type SourceFile,
} from "@typescript/native/ast";
import { SymbolFlags, type Symbol as TSSymbol, type Type } from "@typescript/native/sync";
import type { AliasChains } from "./alias-chain.ts";
import { nodeKey, type Inventory } from "./inventory.ts";
import { renderPosition } from "./position.ts";
import { UNANSWERED } from "./query.ts";
import type { Reference } from "./references.ts";
import type { ProjectView } from "./session.ts";

/** One call or construction passing an object literal, and the declaration that writes it. */
interface Passing {
  readonly file: SourceFile;
  readonly from: string;
  readonly call: CallExpression | NewExpression;
}

/** A node where an outside value takes a type of the target, and the declaration that writes it. */
interface HandedOver {
  readonly file: SourceFile;
  readonly from: string;
  readonly node: Expression;
}

/** The value an `as` expression asserts a type of, through every `as` and parenthesis around it. */
function castOperand(node: Expression): Expression {
  let at = node;
  while (isAsExpression(at) || isParenthesizedExpression(at)) {
    at = at.expression;
  }
  return at;
}

/** Whether a declaration node carries a body of statements or an expression. */
function hasBody(node: Node): boolean {
  return (node as { readonly body?: Node }).body !== undefined;
}

function isFunctionLike(node: Node | undefined): boolean {
  return (
    node !== undefined &&
    (isArrowFunction(node) ||
      isFunctionExpression(node) ||
      isFunctionDeclaration(node) ||
      isClassExpression(node))
  );
}

/** The name a declaration is declared under, where it has one an identifier spells. */
function nameOf(node: Node): string | undefined {
  const name = (node as { readonly name?: Node }).name;
  return name !== undefined && isIdentifier(name) ? name.text : undefined;
}

/**
 * Whether an overload signature has its implementation beside it: a declaration of the same
 * name and kind, in the same statement list or class body, that carries a body.
 */
function overloadImplemented(node: Node): boolean {
  if (!isFunctionDeclaration(node) && !isMethodDeclaration(node)) {
    return false;
  }
  const name = nameOf(node);
  let implemented = false;
  node.parent.forEachChild((sibling) => {
    implemented ||= sibling.kind === node.kind && nameOf(sibling) === name && hasBody(sibling);
  });
  return implemented;
}

/** Every object literal one argument holds, the argument itself included, through nested property values. */
function literalsOf(argument: Expression): readonly ObjectLiteralExpression[] {
  if (!isObjectLiteralExpression(argument)) {
    return [];
  }
  return [
    argument,
    ...argument.properties.flatMap((property) =>
      isPropertyAssignment(property) ? literalsOf(property.initializer) : [],
    ),
  ];
}

/**
 * The reads the object-literal arguments of one project's own files make of the members of
 * the types they are checked against, where the callee has no implementation in the target.
 */
export function unimplementedCalleeReads<Brand>(
  project: ProjectView<Brand>,
  held: Inventory,
  chains: AliasChains,
  root: string,
  testFiles: ReadonlySet<string>,
): readonly Reference[] {
  const queries = project.queries;
  const own = project.ownPaths();
  const passing: Passing[] = [];
  const implementing: Node[] = [];
  const asserted: (HandedOver & { readonly operand: Expression })[] = [];
  const constructed: Passing[] = [];
  const handing: (CallExpression | NewExpression)[] = [];
  for (const file of project.ownSourceFiles()) {
    const fileId = held.declarations.get(nodeKey(file, file));
    if (fileId === undefined) {
      continue;
    }
    const visit = (node: Node, from: string): void => {
      const holder = held.declarations.get(nodeKey(file, node)) ?? from;
      if (
        (isCallExpression(node) || isNewExpression(node)) &&
        (node.arguments ?? []).some((argument) => isObjectLiteralExpression(argument))
      ) {
        passing.push({ file, from: holder, call: node });
      }
      if (isNewExpression(node)) {
        constructed.push({ file, from: holder, call: node });
      }
      if (
        (isCallExpression(node) || isNewExpression(node)) &&
        (node.arguments ?? []).some(
          (argument) => isFunctionLike(argument) || isIdentifier(argument),
        )
      ) {
        handing.push(node);
      }
      if (isAsExpression(node) && !isAsExpression(node.parent)) {
        asserted.push({ file, from: holder, node, operand: castOperand(node) });
      }
      if (isClassDeclaration(node) || isClassExpression(node)) {
        for (const clause of node.heritageClauses ?? []) {
          if (isHeritageClause(clause)) {
            implementing.push(
              ...clause.types.map((one) =>
                isTypeReferenceNode(one) ? one.typeName : one.expression,
              ),
            );
          }
        }
      }
      // An object literal typed as an interface implements that interface's methods.
      if (
        isVariableDeclaration(node) &&
        node.type !== undefined &&
        isTypeReferenceNode(node.type) &&
        node.initializer !== undefined &&
        isObjectLiteralExpression(node.initializer)
      ) {
        implementing.push(node.type.typeName);
      }
      if (
        (isSatisfiesExpression(node) || isAsExpression(node)) &&
        isObjectLiteralExpression(node.expression) &&
        isTypeReferenceNode(node.type)
      ) {
        implementing.push(node.type.typeName);
      }
      node.forEachChild((child) => {
        visit(child, holder);
      });
    };
    file.forEachChild((child) => {
      visit(child, fileId);
    });
  }
  if (passing.length === 0 && asserted.length === 0 && constructed.length === 0) {
    return [];
  }

  const resolved = (symbol: TSSymbol | undefined | typeof UNANSWERED): TSSymbol | undefined => {
    if (symbol === UNANSWERED || symbol === undefined) {
      return undefined;
    }
    if ((symbol.flags & SymbolFlags.Alias) === 0) {
      return symbol;
    }
    const target = queries.aliased(symbol);
    return target === UNANSWERED ? undefined : target;
  };
  const declarationsOf = (symbol: TSSymbol | undefined): readonly Node[] =>
    (symbol?.declarations ?? []).flatMap((handle) => {
      const node = project.declarationAt(handle)?.node;
      return node === undefined ? [] : [node];
    });

  const implemented = new Set<Node>(
    queries.symbolsAt(implementing).flatMap((symbol) => declarationsOf(resolved(symbol))),
  );

  /** Whether a declaration is a function or a class of the target, or a variable or property it initializes. */
  const ownFunction = (node: Node): boolean =>
    own.has(node.getSourceFile().fileName) &&
    (isFunctionLike(node) ||
      ((isVariableDeclaration(node) || isPropertyAssignment(node) || isPropertyDeclaration(node)) &&
        isFunctionLike(node.initializer)));

  /**
   * Whether a function or a class of the target reaches one parameter of a function of the
   * target, passed for it by a call that names the function. A call through another name
   * is not followed, so its callee keeps no implementation and its literal reads more.
   */
  const reachedParameters = new Map<ParameterDeclaration, boolean>();
  const parameterReached = (parameter: ParameterDeclaration): boolean => {
    const known = reachedParameters.get(parameter);
    if (known !== undefined) {
      return known;
    }
    const fn = parameter.parent;
    const fnName = nameOf(fn) ?? (isVariableDeclaration(fn.parent) ? nameOf(fn.parent) : undefined);
    const at =
      (fn as { readonly parameters?: readonly Node[] }).parameters?.indexOf(parameter) ?? -1;
    const passed = handing.flatMap((call) => {
      const callee = call.expression;
      const name = isPropertyAccessExpression(callee) ? callee.name : callee;
      if (fnName === undefined || !isIdentifier(name) || name.text !== fnName) {
        return [];
      }
      const signature = queries.resolvedSignature(call);
      const handle =
        signature === UNANSWERED || signature === undefined ? undefined : signature.declaration;
      const argument =
        handle === undefined || project.declarationAt(handle)?.node !== fn
          ? undefined
          : (call.arguments ?? [])[at];
      return argument === undefined || at < 0 ? [] : [argument];
    });
    const named = passed.filter((argument) => isIdentifier(argument));
    const reached =
      passed.some((argument) => isFunctionLike(argument)) ||
      queries
        .symbolsAt(named)
        .some((symbol) => declarationsOf(resolved(symbol)).some((node) => ownFunction(node)));
    reachedParameters.set(parameter, reached);
    return reached;
  };

  /** Whether some function, class or object literal of the target stands for a signature. */
  const standsFor = (passed: Passing): boolean => {
    const signature = queries.resolvedSignature(passed.call);
    const handle =
      signature === UNANSWERED || signature === undefined ? undefined : signature.declaration;
    const declaration = handle === undefined ? undefined : project.declarationAt(handle)?.node;
    if (declaration === undefined) {
      return true;
    }
    if (hasBody(declaration) || overloadImplemented(declaration)) {
      return own.has(handle?.path ?? "");
    }
    const holder = declaration.parent as Node | undefined;
    if (holder !== undefined && implemented.has(holder)) {
      return true;
    }
    const callee = passed.call.expression;
    const name = isPropertyAccessExpression(callee) ? callee.name : callee;
    const [named] = queries.symbolsAt([name]);
    return declarationsOf(resolved(named)).some((node) =>
      isParameterDeclaration(node)
        ? own.has(node.getSourceFile().fileName) && parameterReached(node)
        : ownFunction(node) && !isFunctionLike(node),
    );
  };

  const literals: { readonly passed: Passing; readonly literal: ObjectLiteralExpression }[] = [];
  for (const passed of passing) {
    if (standsFor(passed)) {
      continue;
    }
    for (const argument of passed.call.arguments ?? []) {
      literals.push(...literalsOf(argument).map((literal) => ({ passed, literal })));
    }
  }
  const contexts = queries.contextualTypes(literals.map((one) => one.literal));

  const found: Reference[] = [];
  literals.forEach(({ passed, literal }, at) => {
    const context = contexts[at];
    if (context === UNANSWERED || context === undefined) {
      return;
    }
    const parts = queries.constituents(context);
    const position = renderPosition(passed.file, root, literal.getStart());
    for (const part of parts === UNANSWERED ? [context] : parts) {
      const properties = queries.propertiesOf(part);
      for (const property of properties === UNANSWERED ? [] : properties) {
        for (const to of chains.declarationsOf(property)) {
          found.push({
            from: passed.from,
            to,
            position,
            use: "read",
            resolution: "contextual",
            test: testFiles.has(position.path),
          });
        }
      }
    }
  });
  found.push(...handedOver());
  return found;

  /** Whether a type is an object no file of the project declares, a platform object's among them. */
  function outsideValue(type: Type): boolean {
    if (!type.isObjectType()) {
      return false;
    }
    const symbol = queries.symbolOfType(type);
    const declared = symbol === UNANSWERED ? undefined : symbol;
    return declared?.declarations.every((handle) => !own.has(handle.path)) === true;
  }

  /** Whether a type is an object type a file of the project declares. */
  function ownObject(type: Type | undefined | typeof UNANSWERED): type is Type {
    const known = type === UNANSWERED ? undefined : type;
    if (!known?.isObjectType()) {
      return false;
    }
    const symbol = queries.symbolOfType(known);
    const declared = symbol === UNANSWERED ? undefined : symbol;
    return declared?.declarations.some((handle) => own.has(handle.path)) === true;
  }

  /** The reads of every member of each target type an outside value is handed over as. */
  function handedOver(): readonly Reference[] {
    const operandTypes = queries.typesAt(asserted.map((one) => one.operand));
    const fromCasts: HandedOver[] = asserted.filter((_one, at) => {
      const type = operandTypes[at];
      return type !== UNANSWERED && type !== undefined && outsideValue(type);
    });
    const newTypes = queries.typesAt(constructed.map((one) => one.call));
    // A construct signature whose declared result is one of its type parameters names no
    // type the target declares, so only a result the signature itself names is handed over.
    const fromConstructors: HandedOver[] = constructed
      .filter((one, at) => {
        if (!ownObject(newTypes[at]) || standsFor(one)) {
          return false;
        }
        const signature = queries.resolvedSignature(one.call);
        const result =
          signature === UNANSWERED || signature === undefined
            ? undefined
            : queries.returnTypeOf(signature);
        return result !== UNANSWERED && result !== undefined && !result.isTypeParameter();
      })
      .map((one) => ({ file: one.file, from: one.from, node: one.call }));
    const handed = [...fromCasts, ...fromConstructors];
    const types = queries.typesAt(handed.map((one) => one.node));
    const reads: Reference[] = [];
    handed.forEach((one, at) => {
      const type = types[at];
      if (type === UNANSWERED || type === undefined) {
        return;
      }
      const position = renderPosition(one.file, root, one.node.getStart());
      const parts = queries.constituents(type);
      for (const part of parts === UNANSWERED ? [type] : parts) {
        if (!ownObject(part)) {
          continue;
        }
        const properties = queries.propertiesOf(part);
        for (const property of properties === UNANSWERED ? [] : properties) {
          for (const to of chains.declarationsOf(property)) {
            reads.push({
              from: one.from,
              to,
              position,
              use: "read",
              resolution: "contextual",
              test: testFiles.has(position.path),
            });
          }
        }
      }
    });
    return reads;
  }
}
