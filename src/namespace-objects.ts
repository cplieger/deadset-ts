/**
 * Module namespace objects: the binding of a namespace import, the value an `await` of a
 * dynamic `import()` produces, the first parameter of the first callback passed to `then`
 * on one, and a `const` binding initialized with one of these. A use reads the exports it
 * names and no other: a property access by name or by a literal index, or a destructured
 * property, names one export, and any other use may read every export.
 */

import {
  isArrowFunction,
  isAwaitExpression,
  isBindingElement,
  isCallExpression,
  isElementAccessExpression,
  isExpressionStatement,
  isFunctionExpression,
  isIdentifier,
  isImportDeclaration,
  isNamespaceImport,
  isNoSubstitutionTemplateLiteral,
  isObjectBindingPattern,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isQualifiedName,
  isStringLiteral,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVoidExpression,
  NodeFlags,
  SyntaxKind,
  type Identifier,
  type Node,
  type SourceFile,
} from "@typescript/native/unstable/ast";

/** What one use of a namespace object reads beyond the names the checker resolves. */
export type NamespaceUse =
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

/** The node a `const` binding's name is visible below: the block or file its statement is in. */
function scopeOf(declaration: Node): Node {
  const statement = declaration.parent.parent;
  return statement.parent;
}

/** Every identifier below `scope` that spells `name`, other than `declared` and a member's name. */
function occurrences(scope: Node, name: string, declared: Node): readonly Identifier[] {
  const found: Identifier[] = [];
  const visit = (node: Node): void => {
    if (isIdentifier(node)) {
      const parent = node.parent;
      const member =
        (isPropertyAccessExpression(parent) && parent.name === node) ||
        (isQualifiedName(parent) && parent.right === node) ||
        (isBindingElement(parent) && parent.propertyName === node);
      if (node !== declared && node.text === name && !member) {
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
 * any use that may read every export. A shadowing declaration of a binding's name inside
 * its scope is read as the binding, which can only keep an export live.
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
      const list = parent.parent;
      if (
        isIdentifier(pattern) &&
        isVariableDeclarationList(list) &&
        (list.flags & NodeFlags.Const) !== 0
      ) {
        binding(pattern, scopeOf(parent), specifier, seen);
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
