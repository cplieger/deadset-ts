import {
  isAsExpression,
  isNonNullExpression,
  isParenthesizedExpression,
  isSatisfiesExpression,
  type Expression,
  type Node,
} from "@typescript/native/ast";

/** The expression inside every pair of parentheses around `node`. */
export function parenthesesRemoved<T extends Node>(node: T): T | Expression {
  let at: T | Expression = node;
  while (isParenthesizedExpression(at)) {
    at = at.expression;
  }
  return at;
}

/**
 * The expression inside every wrapper around `node` that changes no value it evaluates to:
 * parentheses, `as` and `satisfies` assertions and the non-null assertion.
 */
export function unwrapped<T extends Node>(node: T): T | Expression {
  let at: T | Expression = node;
  while (
    isParenthesizedExpression(at) ||
    isAsExpression(at) ||
    isSatisfiesExpression(at) ||
    isNonNullExpression(at)
  ) {
    at = at.expression;
  }
  return at;
}
