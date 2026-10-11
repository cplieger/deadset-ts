/**
 * The members a comparison with a key reads: where one operand of `===`, `!==`, `==` or
 * `!=`, or a `switch` expression a `case` label is compared with, is declared with a type
 * that holds `keyof X`, the literal the other side has names the member of `X` under that
 * key, because deleting the member makes the comparison a type error.
 */

import {
  isBinaryExpression,
  isCaseClause,
  isElementAccessExpression,
  isIdentifier,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isSwitchStatement,
  isTypeOperatorNode,
  SyntaxKind,
  type Expression,
  type Node,
  type SourceFile,
  type TypeNode,
} from "@typescript/native/ast";
import { SymbolFlags, type Type } from "@typescript/native/sync";
import type { AliasChains } from "./alias-chain.ts";
import { nodeKey, type Inventory } from "./inventory.ts";
import { renderPosition } from "./position.ts";
import { UNANSWERED } from "./query.ts";
import type { Reference } from "./references.ts";
import type { ProjectView } from "./session.ts";

/** The operators that compare their operands for equality. */
const EQUALITIES: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsEqualsToken,
  SyntaxKind.EqualsEqualsToken,
  SyntaxKind.ExclamationEqualsToken,
]);

/** One comparison of a keyed operand with another, and the declaration that writes it. */
interface Comparison {
  readonly file: SourceFile;
  readonly from: string;
  readonly keyed: Expression;
  readonly other: Expression;
}

function unwrapped(node: Expression): Expression {
  return isParenthesizedExpression(node) ? unwrapped(node.expression) : node;
}

/** The name node an operand's symbol is read at: an identifier, or a property access's name. */
function nameOf(node: Expression): Node | undefined {
  const at = unwrapped(node);
  if (isIdentifier(at)) {
    return at;
  }
  return isPropertyAccessExpression(at) ? at.name : undefined;
}

/** The operand of each `keyof` one type node holds, through every type node it is built of. */
function keyofOperands(node: TypeNode): readonly TypeNode[] {
  const found: TypeNode[] = [];
  const visit = (at: Node): void => {
    if (isTypeOperatorNode(at) && at.operator === SyntaxKind.KeyOfKeyword) {
      found.push(at.type);
      return;
    }
    at.forEachChild(visit);
  };
  visit(node);
  return found;
}

/** The names a literal type or a union of them spells, or none. */
function literalNames(parts: readonly Type[]): readonly string[] {
  const names: string[] = [];
  for (const part of parts) {
    if (part.isStringLiteralType()) {
      names.push(part.value);
    } else if (part.isNumberLiteralType()) {
      names.push(String(part.value));
    } else {
      return [];
    }
  }
  return names;
}

/**
 * The references the key comparisons of one project's own files make to the members their
 * literal side names, each made by the declaration holding the comparison.
 */
export function keyofComparisonReferences<Brand>(
  project: ProjectView<Brand>,
  held: Inventory,
  chains: AliasChains,
  root: string,
  testFiles: ReadonlySet<string>,
): readonly Reference[] {
  const queries = project.queries;
  const comparisons: Comparison[] = [];
  for (const file of project.ownSourceFiles()) {
    const fileId = held.declarations.get(nodeKey(file, file));
    if (fileId === undefined) {
      continue;
    }
    const visit = (node: Node, from: string): void => {
      const holder = held.declarations.get(nodeKey(file, node)) ?? from;
      if (isBinaryExpression(node) && EQUALITIES.has(node.operatorToken.kind)) {
        comparisons.push({ file, from: holder, keyed: node.left, other: node.right });
        comparisons.push({ file, from: holder, keyed: node.right, other: node.left });
      }
      if (isSwitchStatement(node)) {
        for (const clause of node.caseBlock.clauses) {
          if (isCaseClause(clause)) {
            comparisons.push({
              file,
              from: holder,
              keyed: node.expression,
              other: clause.expression,
            });
          }
        }
      }
      node.forEachChild((child) => {
        visit(child, holder);
      });
    };
    file.forEachChild((child) => {
      visit(child, fileId);
    });
  }
  const named = comparisons.flatMap((one) => {
    const name = nameOf(one.keyed);
    return name === undefined || isElementAccessExpression(unwrapped(one.other))
      ? []
      : [{ ...one, name }];
  });
  if (named.length === 0) {
    return [];
  }

  // The operand's own declaration states the key type, which the checker resolves to
  // the literals it admits and so no longer names the type the key indexes.
  const symbols = queries.symbolsAt(named.map((one) => one.name));
  const keyed = named.flatMap((one, at) => {
    const asked = symbols[at];
    const symbol =
      asked === UNANSWERED || asked === undefined || (asked.flags & SymbolFlags.Alias) === 0
        ? asked
        : queries.aliased(asked);
    if (symbol === UNANSWERED || symbol === undefined) {
      return [];
    }
    const operands = symbol.declarations.flatMap((handle) => {
      const declared = (
        project.declarationAt(handle)?.node as { readonly type?: TypeNode } | undefined
      )?.type;
      return declared === undefined ? [] : keyofOperands(declared);
    });
    return operands.length === 0 ? [] : [{ ...one, operands }];
  });
  if (keyed.length === 0) {
    return [];
  }
  const nodes = keyed.flatMap((one) => [one.other, ...one.operands]);
  const types = queries.typesAt(nodes);
  const typeOf = new Map<Node, Type>();
  nodes.forEach((node, at) => {
    const type = types[at];
    if (type !== UNANSWERED && type !== undefined) {
      typeOf.set(node, type);
    }
  });
  const partsOf = (type: Type): readonly Type[] => {
    const parts = queries.constituents(type);
    return parts === UNANSWERED ? [type] : parts;
  };

  const found: Reference[] = [];
  for (const one of keyed) {
    const literal = typeOf.get(one.other);
    const names = literal === undefined ? [] : literalNames(partsOf(literal));
    if (names.length === 0) {
      continue;
    }
    const position = renderPosition(one.file, root, one.other.getStart());
    for (const operand of one.operands) {
      const object = typeOf.get(operand);
      for (const part of object === undefined ? [] : partsOf(object)) {
        const properties = queries.propertiesOf(part);
        for (const property of properties === UNANSWERED ? [] : properties) {
          if (!names.includes(property.name)) {
            continue;
          }
          for (const to of chains.declarationsOf(property)) {
            found.push({
              from: one.from,
              to,
              position,
              use: "read",
              resolution: "keyed",
              test: testFiles.has(position.path),
            });
          }
        }
      }
    }
  }
  return found;
}
