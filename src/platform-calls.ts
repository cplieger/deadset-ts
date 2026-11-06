/**
 * Which calls are the platform's `require` or AMD's `define` and which constructions its `URL`
 * (roots.23, references-ts.37, references-ts.1), decided once over the bindings of the names a callee is written with: the
 * checker's in a program, the file's own scopes in a module read outside every program.
 */

import {
  isBindingElement,
  isCallExpression,
  isExportSpecifier,
  isIdentifier,
  isImportSpecifier,
  isPropertyAccessExpression,
  isStringLiteral,
  isVariableDeclaration,
  type Identifier,
  type Node,
} from "@typescript/native/ast";
import { parenthesesRemoved, unwrapped } from "./unwrap.ts";

/** A name of the platform the analysis reads calls of. */
type PlatformName = "require" | "createRequire" | "define" | "URL";

/** What one written name is bound to, as far as its reader can tell. */
export interface Bound {
  /** Its own name, and each one an import, a re-export or a destructuring carries it by. */
  readonly names: ReadonlySet<string>;
  /** The declarations of the target it resolves to, a variable's initializer read through. */
  readonly own: readonly Node[];
  /** Whether the type checker proves it the target's own, a function or a class it writes with a body. */
  readonly provenOwn: boolean;
}

/** The binding of each written name, `undefined` where nothing answers which declaration it names. */
export type BindingOf = (written: Identifier) => Bound | undefined;

/** The name one declaration carries a binding by beside its own: the export an import or a re-export names, or the property a destructuring reads. */
export function carriedNames(node: Node): readonly string[] {
  if (isImportSpecifier(node) || isExportSpecifier(node)) {
    return [(node.propertyName ?? node.name).text];
  }
  const property = isBindingElement(node) ? node.propertyName : undefined;
  return property !== undefined && (isIdentifier(property) || isStringLiteral(property))
    ? [property.text]
    : [];
}

/**
 * A written name's binding as a file states it, with no checker to ask, so nothing is
 * proven the target's own (conventions.3): `declarationOf` names the declaration a name
 * resolves to, and a property is read by how it is written alone.
 */
export function lexicalBinding(
  declarationOf: (written: Identifier) => Node | undefined,
): BindingOf {
  return (written) => {
    const parent = written.parent;
    if (isPropertyAccessExpression(parent) && parent.name === written) {
      return undefined;
    }
    const declaration = declarationOf(written);
    return {
      names: new Set([
        written.text,
        ...(declaration === undefined ? [] : carriedNames(declaration)),
      ]),
      own: declaration === undefined ? [] : [declaration],
      provenOwn: false,
    };
  };
}

/** The name a callee or a constructor is written with, parentheses removed: an identifier or a property name. */
export function writtenName(expression: Node): Identifier | undefined {
  const at = parenthesesRemoved(expression);
  if (isIdentifier(at)) {
    return at;
  }
  return isPropertyAccessExpression(at) && isIdentifier(at.name) ? at.name : undefined;
}

/**
 * Whether a call or construction through `callee` is one of the platform's `name`: never
 * where its binding is proven the target's own; otherwise where it is written or carried
 * by that name, or resolves to a variable of the target whose initializer is such a
 * callee or, for `require`, a call of a `createRequire`. A callee nothing binds is read by
 * how it is written.
 */
export function callsPlatformBy(
  name: PlatformName,
  callee: Identifier,
  bindingOf: BindingOf,
  seen = new Set<Node>(),
): boolean {
  const bound = bindingOf(callee);
  if (bound?.provenOwn === true) {
    return false;
  }
  if (callee.text === name || bound?.names.has(name) === true) {
    return true;
  }
  return (bound?.own ?? []).some((node) => {
    if (seen.has(node) || !isVariableDeclaration(node) || node.initializer === undefined) {
      return false;
    }
    seen.add(node);
    const value = unwrapped(node.initializer);
    if (isCallExpression(value)) {
      const called = writtenName(value.expression);
      return (
        name === "require" &&
        called !== undefined &&
        callsPlatformBy("createRequire", called, bindingOf, seen)
      );
    }
    const written = writtenName(value);
    return written !== undefined && callsPlatformBy(name, written, bindingOf, seen);
  });
}
