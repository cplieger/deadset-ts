/**
 * What a written expression evaluates to, the one definition every pass shares: the
 * values it can be, the values a call's argument carries inside the literals it writes,
 * and the positions a program hands a value to that the checker types from their context.
 */

import {
  isArrayLiteralExpression,
  isArrowFunction,
  isAsExpression,
  isBinaryExpression,
  isCallExpression,
  isConditionalExpression,
  isIdentifier,
  isNewExpression,
  isNonNullExpression,
  isObjectLiteralExpression,
  isOmittedExpression,
  isParameterDeclaration,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isReturnStatement,
  isSatisfiesExpression,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isVariableDeclaration,
  SyntaxKind,
  type Expression,
  type Node,
} from "@typescript/native/ast";

/** The operators of an assignment whose right side is stored into the left side's type. */
const STORES: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.EqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.AmpersandAmpersandEqualsToken,
]);

/** Whether a declaration writes its type, so its initializer is read in that type's context. */
function writesType(node: Node): boolean {
  return (node as { readonly type?: Node }).type !== undefined;
}

/**
 * The expressions one written value can evaluate to, each read alone because the checker
 * reduces a union by subtype, so the type at the whole drops a class another branch's
 * extends: the operand of a spread, of parentheses and of `!`, each branch of a
 * conditional, each operand of `??` and `||`, and the right operand of `&&` and of a
 * comma. The left operand of `&&` is its value only where it is falsy, which no object
 * is. An assertion is a value of its own, whose type its reader decides.
 */
export function valuesOf(expression: Expression): readonly Expression[] {
  if (isSpreadElement(expression) || isParenthesizedExpression(expression)) {
    return valuesOf(expression.expression);
  }
  if (isNonNullExpression(expression)) {
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

/** The name node a callee, a decorator expression or a value resolves through, where it has one. */
export function nameOf(expression: Expression): Node | undefined {
  if (isParenthesizedExpression(expression)) {
    return nameOf(expression.expression);
  }
  if (isPropertyAccessExpression(expression)) {
    return expression.name;
  }
  return isIdentifier(expression) ? expression : undefined;
}

/** One value an argument carries, and the node its declaration is resolved from. */
export interface CarriedValue {
  /** Where the value is written, which is where a record of it sits. */
  readonly site: Node;
  /** The name the value is resolved through, the shorthand assignment that holds it, or none. */
  readonly name: Node | undefined;
  readonly shorthand: boolean;
}

/**
 * The values one argument carries: each value it can be ({@link valuesOf}), or what an
 * array or object literal it can be holds, at any depth, through spreads and shorthand
 * properties. Each value is read inside every assertion around it.
 */
export function carriedValues(argument: Expression): readonly CarriedValue[] {
  return valuesOf(argument).flatMap((value): readonly CarriedValue[] => {
    let at = value;
    while (isAsExpression(at) || isSatisfiesExpression(at)) {
      at = at.expression;
    }
    if (at !== value) {
      return carriedValues(at);
    }
    if (isArrayLiteralExpression(value)) {
      return value.elements.flatMap(carriedValues);
    }
    if (isObjectLiteralExpression(value)) {
      return value.properties.flatMap((property): readonly CarriedValue[] => {
        if (isPropertyAssignment(property)) {
          return carriedValues(property.initializer);
        }
        if (isSpreadAssignment(property)) {
          return carriedValues(property.expression);
        }
        return isShorthandPropertyAssignment(property)
          ? [{ site: property.name, name: property, shorthand: true }]
          : [];
      });
    }
    return isOmittedExpression(value)
      ? []
      : [{ site: value, name: nameOf(value), shorthand: false }];
  });
}

/** The expressions one node hands to a position typed by its context. */
export function handedOn(node: Node): readonly Expression[] {
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
