import {
  isArrowFunction,
  isClassDeclaration,
  isClassExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isVariableDeclaration,
} from "@typescript/native/ast";
import { SymbolFlags, type Symbol as TSSymbol } from "@typescript/native/sync";
import { isAmbient } from "./inventory.ts";
import type { ProjectView } from "./session.ts";
import { unwrapped } from "./unwrap.ts";

/**
 * Whether `symbol`, through its aliases, names a function or class the target writes with a
 * body, which a call or construction runs in place of the platform's `require` or `URL`. Any
 * other answer, an unresolved one included, is the platform's, whose call loads a file.
 */
export function hasOwnBody<Brand>(project: ProjectView<Brand>, symbol: TSSymbol): boolean {
  const named = (symbol.flags & SymbolFlags.Alias) === 0 ? symbol : project.queries.aliased(symbol);
  const own = project.ownPaths();
  return (
    typeof named === "object" &&
    named.declarations.some((handle) => {
      const node = own.has(handle.path) ? project.declarationAt(handle)?.node : undefined;
      const value =
        node !== undefined && isVariableDeclaration(node) && node.initializer !== undefined
          ? unwrapped(node.initializer)
          : node;
      return (
        value !== undefined &&
        (isFunctionDeclaration(value)
          ? value.body !== undefined
          : isFunctionExpression(value) ||
            isArrowFunction(value) ||
            isClassDeclaration(value) ||
            isClassExpression(value)) &&
        !isAmbient(value.getSourceFile(), value)
      );
    })
  );
}
