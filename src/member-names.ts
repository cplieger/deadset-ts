/**
 * The members of one project's inventory by the name each is written with, for the
 * classes whose evidence is a name rather than a type relation: a template and a
 * string key both hold a name and nothing else, so each holds back every member of
 * that name its own mechanism can reach.
 */

import {
  isIdentifier,
  isNumericLiteral,
  isPrivateIdentifier,
  isStringLiteral,
  type Node,
  type SourceFile,
} from "@typescript/native/unstable/ast";
import { nodeKey, type Inventory, type InventorySymbol, type SymbolKind } from "./inventory.ts";

/** The kinds of declaration a member name can name. */
const MEMBER_KINDS: ReadonlySet<SymbolKind> = new Set([
  "method",
  "class-member",
  "interface-method",
  "type-member",
  "enum-member",
]);

/**
 * The name a member declaration is written with: an identifier's text, a private
 * name's text without its `#`, a string key's value and a numeric key's text. A
 * private name is indexed under the name a template or a string would spell, so the
 * rule that no such evidence holds it back is the framework's alone. A computed key
 * names nothing a string can be equal to before the program runs.
 */
function writtenName(name: Node | undefined): string | undefined {
  if (name === undefined) {
    return undefined;
  }
  if (isPrivateIdentifier(name)) {
    return name.text.replace(/^#/u, "");
  }
  if (isIdentifier(name)) {
    return name.text;
  }
  if (isStringLiteral(name) || isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

/**
 * Every member the inventory holds, keyed by the name it is written with, each
 * member once and in inventory order. A getter and a setter of one name are one
 * member.
 */
export function memberNames(
  files: readonly SourceFile[],
  held: Inventory,
): ReadonlyMap<string, readonly InventorySymbol[]> {
  const byId = new Map(held.symbols.map((symbol) => [symbol.id, symbol]));
  const named = new Map<string, string>();
  for (const file of files) {
    const visit = (node: Node): void => {
      const id = held.declarations.get(nodeKey(file, node));
      const symbol = id === undefined ? undefined : byId.get(id);
      if (symbol !== undefined && MEMBER_KINDS.has(symbol.kind)) {
        const name = writtenName((node as { readonly name?: Node }).name);
        if (name !== undefined) {
          named.set(symbol.id, name);
        }
      }
      node.forEachChild(visit);
    };
    visit(file);
  }
  const index = new Map<string, InventorySymbol[]>();
  for (const symbol of held.symbols) {
    const name = named.get(symbol.id);
    if (name === undefined) {
      continue;
    }
    const members = index.get(name);
    if (members === undefined) {
      index.set(name, [symbol]);
    } else {
      members.push(symbol);
    }
  }
  return index;
}
