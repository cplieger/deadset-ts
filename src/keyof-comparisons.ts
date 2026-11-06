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
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isPropertyAccessExpression,
  isStringLiteral,
  isSwitchStatement,
  isTypeOperatorNode,
  SyntaxKind,
  type Expression,
  type Node,
  type SourceFile,
  type TypeNode,
} from "@typescript/native/ast";
import { SymbolFlags, type Type } from "@typescript/native/sync";
import { UNANSWERED } from "./query.ts";
import type { Read, ReadRule } from "./references/read-rule.ts";
import { parenthesesRemoved } from "./unwrap.ts";

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

/** The name node an operand's symbol is read at: an identifier, or a property access's name. */
function nameOf(node: Expression): Node | undefined {
  const at = parenthesesRemoved(node);
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
 * The reads the key comparisons of a side's files make of the members their literal side
 * names, each made by the declaration holding the comparison. A question the checker leaves
 * unanswered holds what its answer could have read.
 */
export const keyofComparisons: ReadRule = {
  start() {
    const comparisons: Comparison[] = [];
    return {
      visit(node, { file, from }) {
        if (isBinaryExpression(node) && EQUALITIES.has(node.operatorToken.kind)) {
          comparisons.push({ file, from, keyed: node.left, other: node.right });
          comparisons.push({ file, from, keyed: node.right, other: node.left });
        }
        if (isSwitchStatement(node)) {
          for (const clause of node.caseBlock.clauses) {
            if (isCaseClause(clause)) {
              comparisons.push({ file, from, keyed: node.expression, other: clause.expression });
            }
          }
        }
      },
      reads({ project, chains }) {
        const queries = project.queries;
        const found: Read[] = [];
        const named = comparisons.flatMap((one) => {
          const name = nameOf(one.keyed);
          return name === undefined || isElementAccessExpression(parenthesesRemoved(one.other))
            ? []
            : [{ ...one, name }];
        });
        if (named.length === 0) {
          return found;
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
          if (symbol === UNANSWERED) {
            const text = literalText(one.other);
            found.push({
              kind: "held",
              from: one.from,
              ...(text === undefined ? {} : { names: [text] }),
            });
            return [];
          }
          if (symbol === undefined) {
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
          return found;
        }
        const nodes = keyed.flatMap((one) => [one.other, ...one.operands]);
        const types = queries.typesAt(nodes);
        const typeOf = new Map<Node, Type | typeof UNANSWERED>();
        nodes.forEach((node, at) => {
          const type = types[at];
          if (type !== undefined) {
            typeOf.set(node, type);
          }
        });
        const partsOf = (type: Type): readonly Type[] => {
          const parts = queries.constituents(type);
          return parts === UNANSWERED ? [type] : parts;
        };
        for (const one of keyed) {
          const literal = typeOf.get(one.other);
          const objects = one.operands.map((operand) => typeOf.get(operand));
          if (literal === UNANSWERED) {
            const known = objects.filter((type) => type !== undefined && type !== UNANSWERED);
            found.push({
              kind: "held",
              from: one.from,
              types: known.flatMap(partsOf),
              ...(known.length < objects.length ? { members: true as const } : {}),
            });
            continue;
          }
          const names = literal === undefined ? [] : literalNames(partsOf(literal));
          if (names.length === 0) {
            continue;
          }
          for (const object of objects) {
            if (object === UNANSWERED) {
              found.push({ kind: "held", from: one.from, names });
              continue;
            }
            for (const part of object === undefined ? [] : partsOf(object)) {
              const properties = queries.propertiesOf(part);
              if (properties === UNANSWERED) {
                found.push({ kind: "held", from: one.from, names });
                continue;
              }
              for (const property of properties) {
                if (!names.includes(property.name)) {
                  continue;
                }
                for (const to of chains.declarationsOf(property)) {
                  found.push({
                    kind: "named",
                    from: one.from,
                    to,
                    file: one.file,
                    at: one.other,
                    use: "read",
                    via: "keyed",
                  });
                }
              }
            }
          }
        }
        return found;
      },
    };
  },
};

/** The text a string or number literal operand spells, where it is one. */
function literalText(node: Expression): string | undefined {
  const at = parenthesesRemoved(node);
  return isStringLiteral(at) || isNumericLiteral(at) || isNoSubstitutionTemplateLiteral(at)
    ? at.text
    : undefined;
}
