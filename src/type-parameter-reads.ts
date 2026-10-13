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
  isTypeParameterDeclaration,
  SyntaxKind,
  type CallExpression,
  type NewExpression,
  type Node,
  type PropertyAccessExpression,
  type SourceFile,
} from "@typescript/native/ast";
import { SymbolFlags, type Type } from "@typescript/native/sync";
import type { AliasChains } from "./alias-chain.ts";
import { nodeKey, type Inventory } from "./inventory.ts";
import { renderPosition } from "./position.ts";
import { isAnswered } from "./query.ts";
import type { Reference } from "./references.ts";
import type { ProjectView } from "./session.ts";

/** How deep a parameter's type is matched against the type a call passes: `readonly T[]` is one level. */
const MATCH_DEPTH = 3;

/** One read of a member through a value whose type is a type parameter. */
interface Read {
  readonly file: SourceFile;
  readonly from: string;
  readonly access: PropertyAccessExpression;
}

/** A node that declares type parameters and parameters, as a generic function does. */
type Generic = Node & {
  readonly typeParameters?: readonly Node[];
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

/**
 * The references the reads through type-parameter-typed values of one project's own files
 * make to the members of the types its calls pass, each made by the declaration holding
 * the read.
 */
export function typeParameterReads<Brand>(
  project: ProjectView<Brand>,
  held: Inventory,
  chains: AliasChains,
  root: string,
  testFiles: ReadonlySet<string>,
): readonly Reference[] {
  const queries = project.queries;
  const reads: Read[] = [];
  const calls: (CallExpression | NewExpression)[] = [];
  for (const file of project.ownSourceFiles()) {
    const fileId = held.declarations.get(nodeKey(file, file));
    if (fileId === undefined) {
      continue;
    }
    const visit = (node: Node, from: string, generic: boolean): void => {
      const holder = held.declarations.get(nodeKey(file, node)) ?? from;
      const inside =
        generic ||
        (node as { readonly typeParameters?: readonly Node[] }).typeParameters !== undefined;
      if (
        inside &&
        isPropertyAccessExpression(node) &&
        isIdentifier(node.name) &&
        !assignedTo(node)
      ) {
        reads.push({ file, from: holder, access: node });
      }
      if (isCallExpression(node) || isNewExpression(node)) {
        calls.push(node);
      }
      node.forEachChild((child) => {
        visit(child, holder, inside);
      });
    };
    file.forEachChild((child) => {
      visit(child, fileId, false);
    });
  }
  if (reads.length === 0) {
    return [];
  }

  // The reads whose receiver the checker types as a type parameter, by the generic declaring it.
  const receivers = queries.typesAt(reads.map((read) => read.access.expression));
  const byGeneric = new Map<Generic, { read: Read; parameter: Type }[]>();
  reads.forEach((read, at) => {
    const type = receivers[at];
    if (type === undefined || !isAnswered(type) || !type.isTypeParameter()) {
      return;
    }
    const symbol = queries.symbolOfType(type);
    const declaration =
      symbol === undefined || !isAnswered(symbol)
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
    return [];
  }

  /** The types `instantiated` holds where `declared` holds `parameter`, matched part for part. */
  const passedFor = (
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
    if (!isAnswered(a) || !isAnswered(b) || a.length !== b.length) {
      return [];
    }
    return a.flatMap((one, at) => {
      const other = b[at];
      return other === undefined ? [] : passedFor(parameter, one, other, depth + 1);
    });
  };

  // Only a call spelling a generic's name is resolved: one request each.
  const spelled = new Set([...byGeneric.keys()].flatMap((generic) => nameOf(generic) ?? []));
  const found = new Map<string, Reference>();
  for (const call of calls) {
    const callee = call.expression;
    const written = isIdentifier(callee)
      ? callee.text
      : isPropertyAccessExpression(callee) && isIdentifier(callee.name)
        ? callee.name.text
        : undefined;
    if (written === undefined || !spelled.has(written)) {
      continue;
    }
    const resolved = queries.resolvedSignature(call);
    if (resolved === undefined || !isAnswered(resolved) || resolved.declaration === undefined) {
      continue;
    }
    const generic = project.declarationAt(resolved.declaration)?.node as Generic | undefined;
    const pending = generic === undefined ? undefined : byGeneric.get(generic);
    const declared = pending === undefined ? undefined : queries.genericOf(resolved);
    if (pending === undefined || declared === undefined || !isAnswered(declared)) {
      continue;
    }
    const count = (generic?.parameters ?? []).length;
    for (const { read, parameter } of pending) {
      const passed: Type[] = [];
      for (let at = 0; at < count; at += 1) {
        const own = queries.parameterType(declared, at);
        const given = queries.typeAtPosition(resolved, at);
        if (own !== undefined && isAnswered(own) && isAnswered(given)) {
          passed.push(...passedFor(parameter, own, given, 0));
        }
      }
      const name = read.access.name.text;
      const position = renderPosition(read.file, root, read.access.name.getStart());
      for (const type of passed) {
        const parts = type.isUnionType() ? queries.constituents(type) : [type];
        for (const part of isAnswered(parts) ? parts : []) {
          const owner = queries.symbolOfType(part);
          if (
            !isAnswered(owner) ||
            owner === undefined ||
            (owner.flags & SymbolFlags.Class) !== 0
          ) {
            continue;
          }
          const properties = queries.propertiesOf(part);
          for (const property of isAnswered(properties) ? properties : []) {
            if (property.name !== name) {
              continue;
            }
            for (const to of chains.declarationsOf(property)) {
              found.set(`${read.from}\u0000${to}\u0000${String(read.access.name.pos)}`, {
                from: read.from,
                to,
                position,
                use: "read",
                resolution: "batch",
                test: testFiles.has(position.path),
              });
            }
          }
        }
      }
    }
  }
  return [...found.values()];
}
