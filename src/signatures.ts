/**
 * The function a declaration of the inventory declares, where it declares one: the node
 * whose parameters, body and result are the declaration's own parts.
 */

import {
  isArrowFunction,
  isClassDeclaration,
  isClassExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isMethodDeclaration,
  isPropertyDeclaration,
  isVariableDeclaration,
  type ArrowFunction,
  type FunctionDeclaration,
  type FunctionExpression,
  type MethodDeclaration,
  type Node,
} from "@typescript/native/unstable/ast";

/** A function-like node that carries a body of its own. */
export type SignatureNode =
  FunctionDeclaration | MethodDeclaration | ArrowFunction | FunctionExpression;

/** Whether one node is a function value written in place: an arrow or a function expression. */
function isFunctionValue(node: Node | undefined): node is ArrowFunction | FunctionExpression {
  return node !== undefined && (isArrowFunction(node) || isFunctionExpression(node));
}

/**
 * The function one declaration declares: a function declaration and a class method with
 * a body are their own; a variable and a class property whose initializer is an arrow or
 * a function expression declare that function. Any other declaration declares none, an
 * overload signature and an abstract or ambient method among them, because no body is
 * there to read its parts.
 */
export function signatureOf(node: Node): SignatureNode | undefined {
  if (isFunctionDeclaration(node)) {
    return node.body === undefined ? undefined : node;
  }
  if (isMethodDeclaration(node)) {
    const owner = node.parent;
    return node.body !== undefined && (isClassDeclaration(owner) || isClassExpression(owner))
      ? node
      : undefined;
  }
  if (
    (isVariableDeclaration(node) || isPropertyDeclaration(node)) &&
    isFunctionValue(node.initializer)
  ) {
    return node.initializer;
  }
  return undefined;
}
