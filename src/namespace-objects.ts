/**
 * Module namespace objects: the binding of a namespace import, the value an `await` of a
 * dynamic `import()` produces, the first parameter of the first callback passed to `then`
 * on one, and a variable binding initialized with one of these. A use reads the exports it
 * names and no other: a property access by name or by a literal index, or a destructured
 * property, names one export, and any other use may read every export.
 */

import {
  isArrowFunction,
  isAwaitExpression,
  isCallExpression,
  isClassStaticBlockDeclaration,
  isElementAccessExpression,
  isExpressionStatement,
  isFunctionExpression,
  isFunctionLikeDeclaration,
  isIdentifier,
  isImportDeclaration,
  isModuleBlock,
  isNamespaceImport,
  isNoSubstitutionTemplateLiteral,
  isObjectBindingPattern,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isQualifiedName,
  isSourceFile,
  isStringLiteral,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVariableStatement,
  isVoidExpression,
  NodeFlags,
  SyntaxKind,
  type Identifier,
  type Node,
  type SourceFile,
} from "@typescript/native/ast";
import { spellsNoBinding } from "./spelled-names.ts";

/** What one use of a namespace object reads beyond the names the checker resolves. */
type NamespaceUse =
  /** Every export of the module `specifier` names. */
  | { readonly kind: "whole"; readonly specifier: Node }
  /** The export a literal index names, the literal being the node to resolve. */
  | { readonly kind: "indexed"; readonly literal: Node };

function isLiteralText(node: Node): boolean {
  return isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node);
}

/** The outermost expression one node is, through the parentheses written around it. */
function parenthesized(node: Node): Node {
  let at = node;
  while (isParenthesizedExpression(at.parent)) {
    at = at.parent;
  }
  return at;
}

/** Whether one call is a dynamic `import()` whose argument is literal text. */
function isLiteralImport(node: Node): boolean {
  if (!isCallExpression(node) || node.expression.kind !== SyntaxKind.ImportKeyword) {
    return false;
  }
  const [argument] = node.arguments;
  return argument !== undefined && isLiteralText(argument);
}

/**
 * The node the binding one declaration list declares is visible below: for `let` and
 * `const`, the loop whose head declares it, or else the block or file its statement is
 * in; for `var`, the function, namespace body, static block or file that holds it.
 */
function scopeOf(list: Node): Node {
  if ((list.flags & (NodeFlags.Let | NodeFlags.Const | NodeFlags.Using)) !== 0) {
    return isVariableStatement(list.parent) ? list.parent.parent : list.parent;
  }
  let at = list.parent;
  while (
    !isSourceFile(at) &&
    !isFunctionLikeDeclaration(at) &&
    !isModuleBlock(at) &&
    !isClassStaticBlockDeclaration(at)
  ) {
    at = at.parent;
  }
  return at;
}

/** Every identifier below `scope` that spells `name` as a reference, other than `declared`. */
function occurrences(scope: Node, name: string, declared: Node): readonly Identifier[] {
  const found: Identifier[] = [];
  const visit = (node: Node): void => {
    if (isIdentifier(node)) {
      if (node !== declared && node.text === name && !spellsNoBinding(node)) {
        found.push(node);
      }
      return;
    }
    node.forEachChild(visit);
  };
  scope.forEachChild(visit);
  return found;
}

/**
 * Every use of the namespace objects one file holds, keyed by the node the use is written
 * at, that reads more than a name the checker resolves: an indexed read by a literal, and
 * any use that may read every export. A use of a shadowing declaration of a binding's
 * name inside its scope is read as a use of the binding, which can only keep an export live.
 */
export function namespaceUses(file: SourceFile): ReadonlyMap<Node, NamespaceUse> {
  const uses = new Map<Node, NamespaceUse>();

  const binding = (name: Identifier, scope: Node, specifier: Node, seen: Set<Node>): void => {
    if (seen.has(name)) {
      return;
    }
    seen.add(name);
    for (const one of occurrences(scope, name.text, name)) {
      value(one, specifier, seen);
    }
  };

  /** One use of a namespace object's value, at `node`. */
  const value = (node: Node, specifier: Node, seen: Set<Node>): void => {
    const at = parenthesized(node);
    const parent = at.parent;
    if (isExpressionStatement(parent) || isVoidExpression(parent)) {
      return;
    }
    if (
      (isPropertyAccessExpression(parent) && parent.expression === at) ||
      (isQualifiedName(parent) && parent.left === at)
    ) {
      return;
    }
    if (isElementAccessExpression(parent) && parent.expression === at) {
      const index = parent.argumentExpression;
      uses.set(
        node,
        isLiteralText(index) ? { kind: "indexed", literal: index } : { kind: "whole", specifier },
      );
      return;
    }
    if (isVariableDeclaration(parent) && parent.initializer === at) {
      const pattern = parent.name;
      if (isObjectBindingPattern(pattern)) {
        const named = pattern.elements.every(
          (element) =>
            element.dotDotDotToken === undefined &&
            element.propertyName?.kind !== SyntaxKind.ComputedPropertyName,
        );
        if (!named) {
          uses.set(node, { kind: "whole", specifier });
        }
        return;
      }
      // A binding that is not `const` is followed too: each assignment to it is an
      // occurrence `value` cannot narrow, so a reassigned binding still reads every export.
      const list = parent.parent;
      if (isIdentifier(pattern) && isVariableDeclarationList(list)) {
        binding(pattern, scopeOf(list), specifier, seen);
        return;
      }
    }
    uses.set(node, { kind: "whole", specifier });
  };

  /** One use of a dynamic `import()` call, at `call`. */
  const imported = (call: Node, specifier: Node, seen: Set<Node>): void => {
    const at = parenthesized(call);
    const parent = at.parent;
    if (isExpressionStatement(parent) || isVoidExpression(parent)) {
      return;
    }
    if (isAwaitExpression(parent)) {
      value(parent, specifier, seen);
      return;
    }
    const then = parent.parent;
    if (
      isPropertyAccessExpression(parent) &&
      parent.expression === at &&
      parent.name.text === "then" &&
      isCallExpression(then) &&
      then.expression === parent
    ) {
      const [callback] = then.arguments;
      if (callback !== undefined && (isArrowFunction(callback) || isFunctionExpression(callback))) {
        const [first] = callback.parameters;
        if (first === undefined || isObjectBindingPattern(first.name)) {
          return;
        }
        if (isIdentifier(first.name)) {
          binding(first.name, callback, specifier, seen);
          return;
        }
      }
    }
    uses.set(call, { kind: "whole", specifier });
  };

  const visit = (node: Node): void => {
    if (isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      if (
        clause !== undefined &&
        clause.phaseModifier !== SyntaxKind.TypeKeyword &&
        bindings !== undefined &&
        isNamespaceImport(bindings)
      ) {
        binding(bindings.name, file, node.moduleSpecifier, new Set());
      }
      return;
    }
    if (isLiteralImport(node) && isCallExpression(node)) {
      const [argument] = node.arguments;
      if (argument !== undefined) {
        imported(node, argument, new Set());
      }
    }
    node.forEachChild(visit);
  };
  file.forEachChild(visit);
  return uses;
}
