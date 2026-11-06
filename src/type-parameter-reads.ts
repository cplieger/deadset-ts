/**
 * The members a read through a value typed by a type parameter reaches: `value.kind`,
 * where `value` is of a type parameter `T` of a generic function, reads `kind` on each
 * object type no class declares that a call of the function passes for `T`, because the
 * call's value is what the read reads, whatever member of the constraint the name resolves
 * to. A class's members a constraint requires are interface satisfaction's.
 */

import {
  isBinaryExpression,
  isCallExpression,
  isIdentifier,
  isNewExpression,
  isPropertyAccessExpression,
  isSourceFile,
  isTypeParameterDeclaration,
  SyntaxKind,
  type CallExpression,
  type NewExpression,
  type Node,
  type PropertyAccessExpression,
  type SourceFile,
} from "@typescript/native/ast";
import { SymbolFlags, type Type } from "@typescript/native/sync";
import { isAnswered, UNANSWERED } from "./query.ts";
import type { Read as RuleRead, ReadRule } from "./references/read-rule.ts";

/** How deep a parameter's type is matched against the type a call passes: `readonly T[]` is one level. */
const MATCH_DEPTH = 3;

/** One read of a member through a value whose type is a type parameter. */
interface Read {
  readonly file: SourceFile;
  readonly from: string;
  readonly access: PropertyAccessExpression;
}

/** A node that declares parameters, as a generic function does. */
type Generic = Node & {
  readonly parameters?: readonly Node[];
};

/** The name a call reaches one generic by: its own, or that of what holds it. */
function nameOf(generic: Generic): string | undefined {
  const own = (generic as { readonly name?: Node }).name;
  const holder = (generic.parent as { readonly name?: Node } | undefined)?.name;
  const name = own ?? holder;
  return name !== undefined && isIdentifier(name) ? name.text : undefined;
}

/** Whether a property access is the target of a plain assignment, which writes the member. */
function assignedTo(access: PropertyAccessExpression): boolean {
  const parent = access.parent;
  return (
    isBinaryExpression(parent) &&
    parent.operatorToken.kind === SyntaxKind.EqualsToken &&
    parent.left === access
  );
}

/** Whether one node is written inside a declaration that declares type parameters, itself included. */
function inGeneric(node: Node): boolean {
  for (let at = node; !isSourceFile(at); at = at.parent) {
    if ((at as { readonly typeParameters?: readonly Node[] }).typeParameters !== undefined) {
      return true;
    }
  }
  return false;
}

/**
 * The reads the reads through type-parameter-typed values of a side's files make of the
 * members of the types its calls pass, each made by the declaration holding the read. A
 * question the checker leaves unanswered holds every member the read's name spells.
 */
export const typeParameterReads: ReadRule = {
  start() {
    const reads: Read[] = [];
    const calls: (CallExpression | NewExpression)[] = [];
    return {
      visit(node, { file, from }) {
        if (
          isPropertyAccessExpression(node) &&
          isIdentifier(node.name) &&
          !assignedTo(node) &&
          inGeneric(node)
        ) {
          reads.push({ file, from, access: node });
        }
        if (isCallExpression(node) || isNewExpression(node)) {
          calls.push(node);
        }
      },
      reads({ project, chains }) {
        const out: RuleRead[] = [];
        if (reads.length === 0) {
          return out;
        }
        const queries = project.queries;
        const hold = (read: Read): void => {
          out.push({ kind: "held", from: read.from, names: [read.access.name.text] });
        };
        // The reads whose receiver the checker types as a type parameter, by the generic declaring it.
        const receivers = queries.typesAt(reads.map((read) => read.access.expression));
        const byGeneric = new Map<Generic, { read: Read; parameter: Type }[]>();
        reads.forEach((read, at) => {
          const type = receivers[at];
          if (type === UNANSWERED) {
            hold(read);
            return;
          }
          if (type?.isTypeParameter() !== true) {
            return;
          }
          const symbol = queries.symbolOfType(type);
          if (symbol === UNANSWERED) {
            hold(read);
            return;
          }
          const declaration =
            symbol === undefined
              ? undefined
              : symbol.declarations
                  .map((handle) => project.declarationAt(handle)?.node)
                  .find((node) => node !== undefined && isTypeParameterDeclaration(node));
          const generic = declaration?.parent as Generic | undefined;
          if (generic !== undefined) {
            byGeneric.set(generic, [...(byGeneric.get(generic) ?? []), { read, parameter: type }]);
          }
        });
        if (byGeneric.size === 0) {
          return out;
        }

        /** The types `instantiated` holds where `declared` holds `parameter`, matched part for part. */
        const passedFor = (
          read: Read,
          parameter: Type,
          declared: Type,
          instantiated: Type,
          depth: number,
        ): readonly Type[] => {
          if (declared.id === parameter.id) {
            return [instantiated];
          }
          if (depth >= MATCH_DEPTH) {
            return [];
          }
          const a = queries.typeArguments(declared);
          const b = queries.typeArguments(instantiated);
          if (!isAnswered(a) || !isAnswered(b)) {
            hold(read);
            return [];
          }
          if (a.length !== b.length) {
            return [];
          }
          return a.flatMap((one, at) => {
            const other = b[at];
            return other === undefined ? [] : passedFor(read, parameter, one, other, depth + 1);
          });
        };

        // Only a call spelling a generic's name is resolved: one request each.
        const bySpelling = new Map<string, Read[]>();
        for (const [generic, pending] of byGeneric) {
          const name = nameOf(generic);
          if (name !== undefined) {
            bySpelling.set(name, [
              ...(bySpelling.get(name) ?? []),
              ...pending.map((one) => one.read),
            ]);
          }
        }
        const found = new Map<string, RuleRead>();
        for (const call of calls) {
          const callee = call.expression;
          const written = isIdentifier(callee)
            ? callee.text
            : isPropertyAccessExpression(callee) && isIdentifier(callee.name)
              ? callee.name.text
              : undefined;
          const spelledBy = written === undefined ? undefined : bySpelling.get(written);
          if (spelledBy === undefined) {
            continue;
          }
          const resolved = queries.resolvedSignature(call);
          if (resolved === UNANSWERED) {
            spelledBy.forEach(hold);
            continue;
          }
          if (resolved?.declaration === undefined) {
            continue;
          }
          const generic = project.declarationAt(resolved.declaration)?.node as Generic | undefined;
          const pending = generic === undefined ? undefined : byGeneric.get(generic);
          const declared = pending === undefined ? undefined : queries.genericOf(resolved);
          if (declared === UNANSWERED) {
            pending?.forEach((one) => {
              hold(one.read);
            });
            continue;
          }
          if (pending === undefined || declared === undefined) {
            continue;
          }
          const count = (generic?.parameters ?? []).length;
          for (const { read, parameter } of pending) {
            const passed: Type[] = [];
            for (let at = 0; at < count; at += 1) {
              const own = queries.parameterType(declared, at);
              const given = queries.typeAtPosition(resolved, at);
              if (own === UNANSWERED || given === UNANSWERED) {
                hold(read);
              } else if (own !== undefined) {
                passed.push(...passedFor(read, parameter, own, given, 0));
              }
            }
            const name = read.access.name.text;
            for (const type of passed) {
              const parts = type.isUnionType() ? queries.constituents(type) : [type];
              for (const part of isAnswered(parts) ? parts : [type]) {
                const owner = queries.symbolOfType(part);
                const properties = queries.propertiesOf(part);
                if (owner === UNANSWERED || properties === UNANSWERED) {
                  hold(read);
                  continue;
                }
                if (owner === undefined || (owner.flags & SymbolFlags.Class) !== 0) {
                  continue;
                }
                for (const property of properties) {
                  if (property.name !== name) {
                    continue;
                  }
                  for (const to of chains.declarationsOf(property)) {
                    found.set(`${read.from}\u0000${to}\u0000${String(read.access.name.pos)}`, {
                      kind: "named",
                      from: read.from,
                      to,
                      file: read.file,
                      at: read.access.name,
                      use: "read",
                      via: "batch",
                    });
                  }
                }
              }
            }
          }
        }
        return [...out, ...found.values()];
      },
    };
  },
};
