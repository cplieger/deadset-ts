/**
 * The values a program hands to a position the checker types from its context: the
 * initializer of a declaration whose type is written, an assignment's right side, an
 * argument, a returned value, an arrow function's expression body, an array element, an
 * object property, and the operand of `as` or `satisfies`.
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
  isParameterDeclaration,
  isParenthesizedExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isReturnStatement,
  isSatisfiesExpression,
  isShorthandPropertyAssignment,
  isSpreadElement,
  isVariableDeclaration,
  SyntaxKind,
  type Expression,
  type Node,
} from "@typescript/native/unstable/ast";

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
 * The values one written expression hands on: the expression itself, or what it
 * evaluates to through parentheses, a conditional and the operators whose result is
 * one of their operands.
 */
export function valuesOf(expression: Expression): readonly Expression[] {
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
