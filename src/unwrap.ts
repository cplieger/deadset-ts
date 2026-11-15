import {
  isArrayLiteralExpression,
  isBindingElement,
  isBlock,
  isCaseClause,
  isCatchClause,
  isClassDeclaration,
  isDefaultClause,
  isForStatement,
  isFunctionDeclaration,
  isFunctionLikeDeclaration,
  isVariableDeclarationList,
  isVariableStatement,
  isAsExpression,
  isBinaryExpression,
  isForInStatement,
  isForOfStatement,
  isIdentifier,
  isNonNullExpression,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAssignment,
  isSatisfiesExpression,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isTypeAssertion,
  isVariableDeclaration,
  NodeFlags,
  SyntaxKind,
  type ArrayLiteralExpression,
  type Expression,
  type Node,
  type ObjectLiteralExpression,
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
 * parentheses, `as`, angle and `satisfies` assertions and the non-null assertion.
 */
export function unwrapped<T extends Node>(node: T): T | Expression {
  let at: T | Expression = node;
  while (
    isParenthesizedExpression(at) ||
    isAsExpression(at) ||
    isTypeAssertion(at) ||
    isSatisfiesExpression(at) ||
    isNonNullExpression(at)
  ) {
    at = at.expression;
  }
  return at;
}

/**
 * The array or object literal an expression evaluates to inside every wrapper
 * {@link unwrapped} removes, or none: the one test of whether a value is written as a
 * literal.
 */
function literalOf(
  node: Node | undefined,
): ArrayLiteralExpression | ObjectLiteralExpression | undefined {
  const at = node === undefined ? undefined : unwrapped(node);
  return at !== undefined && (isArrayLiteralExpression(at) || isObjectLiteralExpression(at))
    ? at
    : undefined;
}

/** The array literal an expression evaluates to, as {@link literalOf} reads it, or none. */
export function arrayLiteralOf(node: Node | undefined): ArrayLiteralExpression | undefined {
  const at = literalOf(node);
  return at !== undefined && isArrayLiteralExpression(at) ? at : undefined;
}

/** The object literal an expression evaluates to, as {@link literalOf} reads it, or none. */
export function objectLiteralOf(node: Node | undefined): ObjectLiteralExpression | undefined {
  const at = literalOf(node);
  return at !== undefined && isObjectLiteralExpression(at) ? at : undefined;
}

/**
 * The literal a variable holds for its whole life, as {@link literalOf} reads its
 * initializer: a `const`, or a `let` its scope assigns nowhere else, a nested scope that
 * declares the name again assigning its own binding.
 */
export function heldLiteral(
  node: Node,
): ArrayLiteralExpression | ObjectLiteralExpression | undefined {
  if (!isVariableDeclaration(node) || !isIdentifier(node.name)) {
    return undefined;
  }
  const literal = literalOf(node.initializer);
  if (literal === undefined) {
    return undefined;
  }
  const list = node.parent;
  if ((list.flags & NodeFlags.Const) !== 0) {
    return literal;
  }
  return (list.flags & NodeFlags.Let) !== 0 &&
    !assigns(isVariableStatement(list.parent) ? list.parent.parent : list.parent, node.name.text)
    ? literal
    : undefined;
}

/** The assignment operators that read their target before they write it. */
export const COMPOUND: ReadonlySet<SyntaxKind> = new Set([
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
 * increment or a decrement, or as the target of a `for…in` or `for…of` loop. A nested
 * scope that declares the name again assigns its own binding, not the body's.
 */
export function assigns(body: Node | undefined, name: string): boolean {
  let found = false;
  const visit = (node: Node): void => {
    if (found || (node !== body && redeclares(node, name))) {
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

/** Whether a binding name or pattern binds `name`. */
function binds(target: Node | undefined, name: string): boolean {
  if (target === undefined) {
    return false;
  }
  if (isIdentifier(target)) {
    return target.text === name;
  }
  let found = false;
  target.forEachChild((child) => {
    found ||= isBindingElement(child) && binds(child.name, name);
  });
  return found;
}

/**
 * Whether a scope declares its own binding of `name`: a function's parameter, a `var`
 * anywhere in its body outside nested functions, or a `let`, `const`, class or function
 * a block, a loop head or a `catch` declares directly.
 */
function redeclares(scope: Node, name: string): boolean {
  const declares = (statement: Node): boolean =>
    (isVariableStatement(statement) &&
      statement.declarationList.declarations.some((one) => binds(one.name, name))) ||
    ((isFunctionDeclaration(statement) || isClassDeclaration(statement)) &&
      statement.name?.text === name);
  if (isFunctionLikeDeclaration(scope)) {
    return (
      scope.parameters.some((one) => binds(one.name, name)) ||
      (scope.body !== undefined && declaresVar(scope.body, name))
    );
  }
  if (isCatchClause(scope)) {
    return binds(scope.variableDeclaration?.name, name);
  }
  if (
    (isForStatement(scope) || isForInStatement(scope) || isForOfStatement(scope)) &&
    scope.initializer !== undefined &&
    isVariableDeclarationList(scope.initializer)
  ) {
    return scope.initializer.declarations.some((one) => binds(one.name, name));
  }
  const statements = (scope as { readonly statements?: readonly Node[] }).statements;
  return (isBlock(scope) || isCaseClause(scope) || isDefaultClause(scope)) &&
    statements !== undefined
    ? statements.some(declares)
    : false;
}

/** Whether a function body declares `name` with `var`, outside the functions it nests. */
function declaresVar(body: Node, name: string): boolean {
  let found = false;
  const visit = (node: Node): void => {
    if (found || isFunctionLikeDeclaration(node)) {
      return;
    }
    found =
      isVariableDeclarationList(node) &&
      (node.flags & (NodeFlags.Let | NodeFlags.Const)) === 0 &&
      node.declarations.some((one) => binds(one.name, name));
    node.forEachChild(visit);
  };
  body.forEachChild(visit);
  return found;
}
