/**
 * The members a unique symbol keys, used through element accesses. `value[key]`, where
 * `key` is a constant of a `unique symbol` type, reads the member of the receiver's type
 * whose computed name is that same constant, and a store through the access writes it.
 * No name node resolves to such a member: the key's name resolves to the constant. An
 * iteration reads the member its well-known iteration symbol keys.
 */

import {
  isComputedPropertyName,
  isForOfStatement,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isPropertyAccessExpression,
  isSpreadElement,
  isStringLiteral,
  type ElementAccessExpression,
  type Expression,
  type Node,
  type SourceFile,
} from "@typescript/native/ast";
import { parenthesesRemoved } from "./unwrap.ts";
import type { Symbol as TSSymbol, Type } from "@typescript/native/sync";
import type { AliasChains } from "./alias-chain.ts";
import { nodeKey, type Inventory, type InventorySymbol } from "./inventory.ts";
import { renderPosition } from "./position.ts";
import { isAnswered, type PropertyTables } from "./query.ts";
import type { Reference } from "./references.ts";
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
  const at = parenthesesRemoved(argument);
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

/** The well-known symbol a value's iteration calls, by the construct that iterates it. */
type Protocol = "iterator" | "asyncIterator";

/** The member name `[Symbol.<name>]` spells, where a computed name spells one. */
function wellKnownName(name: Node | undefined): string | undefined {
  if (name === undefined || !isComputedPropertyName(name)) {
    return undefined;
  }
  const key = name.expression;
  return isPropertyAccessExpression(key) &&
    isIdentifier(key.expression) &&
    key.expression.text === "Symbol" &&
    isIdentifier(key.name)
    ? key.name.text
    : undefined;
}

/**
 * The references the iterations of one project's own files make to the iteration members
 * of the values they iterate: a `for…of` statement and a spread element read
 * `[Symbol.iterator]`, and a `for await…of` statement reads `[Symbol.asyncIterator]` and,
 * which it falls back to, `[Symbol.iterator]`. Each is made by the declaration holding it.
 */
export function iterationReferences<Brand>(
  project: ProjectView<Brand>,
  held: Inventory,
  chains: AliasChains,
  root: string,
  testFiles: ReadonlySet<string>,
): readonly Reference[] {
  const queries = project.queries;
  const ownPaths = project.ownPaths();
  const iterated: {
    readonly file: SourceFile;
    readonly from: string;
    readonly operand: Expression;
    readonly protocols: readonly Protocol[];
  }[] = [];
  for (const file of project.ownSourceFiles()) {
    const fileId = held.declarations.get(nodeKey(file, file));
    if (fileId === undefined) {
      continue;
    }
    const visit = (node: Node, from: string): void => {
      const holder = held.declarations.get(nodeKey(file, node)) ?? from;
      if (isForOfStatement(node)) {
        const protocols: readonly Protocol[] =
          node.awaitModifier === undefined ? ["iterator"] : ["asyncIterator", "iterator"];
        iterated.push({ file, from: holder, operand: node.expression, protocols });
      } else if (isSpreadElement(node)) {
        iterated.push({ file, from: holder, operand: node.expression, protocols: ["iterator"] });
      }
      node.forEachChild((child) => {
        visit(child, holder);
      });
    };
    file.forEachChild((child) => {
      visit(child, fileId);
    });
  }
  if (iterated.length === 0) {
    return [];
  }
  const types = queries.typesAt(iterated.map((one) => one.operand));
  const members = new Map<
    number,
    readonly { readonly name: string; readonly ids: readonly string[] }[]
  >();
  const membersOf = (
    type: Type,
  ): readonly { readonly name: string; readonly ids: readonly string[] }[] => {
    const known = members.get(type.id);
    if (known !== undefined) {
      return known;
    }
    const keyed: { name: string; ids: readonly string[] }[] = [];
    const properties = queries.propertiesOf(type);
    for (const property of isAnswered(properties) ? properties : []) {
      for (const handle of property.declarations) {
        const node = ownPaths.has(handle.path) ? project.declarationAt(handle)?.node : undefined;
        const name = wellKnownName((node as { readonly name?: Node } | undefined)?.name);
        if (name !== undefined) {
          keyed.push({ name, ids: chains.declarationsOf(property) });
          break;
        }
      }
    }
    members.set(type.id, keyed);
    return keyed;
  };
  const found: Reference[] = [];
  iterated.forEach((one, index) => {
    const type = types[index];
    if (type === undefined || !isAnswered(type)) {
      return;
    }
    const parts =
      type.isUnionType() || type.isIntersectionType() ? queries.constituents(type) : [type];
    const position = renderPosition(one.file, root, one.operand.getStart());
    for (const part of isAnswered(parts) ? parts : []) {
      for (const member of membersOf(part)) {
        if (!(one.protocols as readonly string[]).includes(member.name)) {
          continue;
        }
        for (const to of member.ids) {
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
  });
  return found;
}
