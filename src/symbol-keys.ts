/**
 * The members a unique symbol keys, used through element accesses. `value[key]`, where
 * `key` is a constant of a `unique symbol` type, reads the member of the receiver's type
 * whose computed name is that same constant, and a store through the access writes it.
 * No name node resolves to such a member: the key's name resolves to the constant.
 */

import {
  isComputedPropertyName,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isStringLiteral,
  type ElementAccessExpression,
  type Node,
} from "@typescript/native/unstable/ast";
import type { Symbol as TSSymbol, Type } from "@typescript/native/unstable/sync";
import type { AliasChains } from "./alias-chain.ts";
import type { InventorySymbol } from "./inventory.ts";
import { isAnswered, type PropertyTables } from "./query.ts";
import type { ProjectView } from "./session.ts";

/** One element access whose key is a name, and how the access uses the member it selects. */
export interface KeyedAccess {
  readonly access: ElementAccessExpression;
  /** The identifier whose symbol is the key: the argument, or the name its property access ends in. */
  readonly key: Node;
  readonly from: string;
  readonly use: "read" | "write" | "both";
}

/** One keyed access with the symbol its key resolved to. */
interface ResolvedKey {
  readonly access: KeyedAccess;
  readonly symbol: TSSymbol;
}

/** The members one keyed access selects, by their inventory identifiers. */
interface KeyedUse {
  readonly access: KeyedAccess;
  readonly ids: readonly string[];
}

/** The identifier an element access's argument names its key by, where it is a name. */
export function keyNameOf(argument: Node): Node | undefined {
  let at = argument;
  while (isParenthesizedExpression(at)) {
    at = at.expression;
  }
  if (isIdentifier(at)) {
    return at;
  }
  return isPropertyAccessExpression(at) && isIdentifier(at.name) ? at.name : undefined;
}

/**
 * The last identifier of each computed member name the inventory holds, `mark` for
 * `[mark]` and `iterator` for `[Symbol.iterator]`: an access whose key is spelled by no
 * such identifier selects no member a unique symbol keys, and is not asked about.
 */
export function computedKeyNames(symbols: readonly InventorySymbol[]): ReadonlySet<string> {
  const names = new Set<string>();
  for (const symbol of symbols) {
    const key = /\[([^\]]+)\]$/u.exec(symbol.name)?.[1];
    const last = key?.split(".").pop()?.trim();
    if (last !== undefined && /^[\p{ID_Start}$_][\p{ID_Continue}$]*$/u.test(last)) {
      names.add(last);
    }
  }
  return names;
}

/** Whether a computed name's expression is literal text, which names a member by its text. */
function isLiteralKey(expression: Node): boolean {
  return (
    isStringLiteral(expression) ||
    isNumericLiteral(expression) ||
    isNoSubstitutionTemplateLiteral(expression)
  );
}

/**
 * The members each keyed access selects. The receivers' types are asked in one batch,
 * each object type's properties once, and the key of every property declared under a
 * computed name in one batch more; a property is selected where its key and the
 * access's key are one symbol.
 */
export function keyedUses<Brand>(
  project: ProjectView<Brand>,
  chains: AliasChains,
  resolved: readonly ResolvedKey[],
  properties: PropertyTables,
  cap: number,
): readonly KeyedUse[] {
  if (resolved.length === 0) {
    return [];
  }
  const queries = project.queries;
  const ownPaths = project.ownPaths();
  const types = queries.typesAt(
    resolved.map((one) => one.access.access.expression),
    cap,
  );

  const parts = new Map<number, readonly Type[]>();
  const partsOf = (type: Type): readonly Type[] => {
    const known = parts.get(type.id);
    if (known !== undefined) {
      return known;
    }
    let found: readonly Type[] = [];
    if (type.isUnionType() || type.isIntersectionType()) {
      const constituents = queries.constituents(type);
      found = isAnswered(constituents) ? constituents.flatMap(partsOf) : [];
    } else if (type.isObjectType()) {
      found = [type];
    }
    parts.set(type.id, found);
    return found;
  };

  /** Each receiver's properties declared in the target under a computed name, with that name's expression. */
  const candidates = new Map<number, { property: TSSymbol; key: Node }[]>();
  const keyNodes: Node[] = [];
  const candidatesOf = (type: Type): readonly { property: TSSymbol; key: Node }[] => {
    const known = candidates.get(type.id);
    if (known !== undefined) {
      return known;
    }
    const found: { property: TSSymbol; key: Node }[] = [];
    const read = properties.of(type);
    for (const property of isAnswered(read.properties) ? read.properties : []) {
      const handle = property.declarations.find((one) => ownPaths.has(one.path));
      const node = handle === undefined ? undefined : project.declarationAt(handle)?.node;
      const name = (node as { readonly name?: Node } | undefined)?.name;
      if (name !== undefined && isComputedPropertyName(name) && !isLiteralKey(name.expression)) {
        found.push({ property, key: name.expression });
        keyNodes.push(name.expression);
      }
    }
    candidates.set(type.id, found);
    return found;
  };

  const perAccess = resolved.map((_one, index) => {
    const type = types[index];
    return type === undefined || !isAnswered(type) ? [] : partsOf(type).flatMap(candidatesOf);
  });
  const keyOf = new Map<Node, number>();
  const asked = [...new Set(keyNodes)];
  (asked.length === 0
    ? []
    : project.symbolsAt(
        asked.map((node) => project.handle(node)),
        cap,
      )
  ).forEach((symbol, index) => {
    const node = asked[index];
    if (node !== undefined && symbol !== undefined && isAnswered(symbol)) {
      keyOf.set(node, symbol.id);
    }
  });

  return resolved.flatMap((one, index) => {
    const ids = (perAccess[index] ?? [])
      .filter((candidate) => keyOf.get(candidate.key) === one.symbol.id)
      .flatMap((candidate) => chains.declarationsOf(candidate.property));
    return ids.length === 0 ? [] : [{ access: one.access, ids: [...new Set(ids)] }];
  });
}
