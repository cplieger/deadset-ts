/**
 * AMD's module forms (references-ts.37), read from the syntax because the binder declares
 * none of them: `define([<ids>], factory)`, `define("<name>", [<ids>], factory)` and
 * `require([<ids>], callback)` (https://github.com/amdjs/amdjs-api/blob/master/AMD.md).
 */

import {
  isArrayLiteralExpression,
  isArrowFunction,
  isFunctionExpression,
  isCallExpression,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isStringLiteral,
  type Identifier,
  type Node,
  type StringLiteralLikeNode,
} from "@typescript/native/ast";
import { hasURLScheme, isAbsolutePath, resolvePath, startsRelativePath } from "./paths.ts";
import { parenthesesRemoved } from "./unwrap.ts";

/** The platform function an AMD call is written as. */
type AmdPlatform = "define" | "require";

/** One AMD call's dependency list. */
export interface AmdLoad {
  /** The name the call is written with; {@link callsPlatform} owns whether it is AMD's. */
  readonly callee: Identifier;
  /** Each dependency id written as literal text, AMD's own `require`, `exports` and `module` left out. */
  readonly ids: readonly AmdDependency[];
  /** Whether the list, or an element of it, is computed, so the call may load any module. */
  readonly computed: boolean;
}

/** One dependency id of an AMD call. */
interface AmdDependency {
  readonly id: StringLiteralLikeNode;
  /**
   * Whether the factory may receive the module's value: it declares a parameter at the id's
   * place, a rest parameter included, or it is written as anything but a function.
   */
  readonly received: boolean;
}

/** The ids AMD binds to the factory's CommonJS parameters, which load no module. */
const FREE_VARIABLES: ReadonlySet<string> = new Set(["require", "exports", "module"]);

/** The platform function `callee` is written as. */
export function amdPlatform(callee: Identifier): AmdPlatform {
  return callee.text === "define" ? "define" : "require";
}

/**
 * The dependency list one call writes, where it is a call of a bare `define` or `require` in
 * one of AMD's forms. A `define` with no list, of a factory or a value alone, loads nothing;
 * a `require` whose first argument is no array literal is CommonJS's.
 */
export function amdLoadOf(node: Node): AmdLoad | undefined {
  if (!isCallExpression(node)) {
    return undefined;
  }
  const callee = parenthesesRemoved(node.expression);
  if (!isIdentifier(callee) || (callee.text !== "define" && callee.text !== "require")) {
    return undefined;
  }
  const written = node.arguments.map((one) => parenthesesRemoved(one));
  const [first] = written;
  if (first === undefined) {
    return undefined;
  }
  const define = callee.text === "define";
  const named = define && isLiteralText(first);
  const list = written[named ? 1 : 0];
  if (list !== undefined && isArrayLiteralExpression(list)) {
    const elements = list.elements.map((one) => parenthesesRemoved(one));
    const factory = written[named ? 2 : 1];
    const ids = elements.flatMap((one, at) =>
      isLiteralText(one) && !FREE_VARIABLES.has(one.text)
        ? [{ id: one, received: receives(factory, at) }]
        : [],
    );
    return { callee, ids, computed: elements.some((one) => !isLiteralText(one)) };
  }
  if (!define) {
    return undefined;
  }
  // A factory after the list's place makes what stands there a list, here a computed one.
  return { callee, ids: [], computed: written.length > (named ? 2 : 1) };
}

function isLiteralText(node: Node): node is StringLiteralLikeNode {
  return isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node);
}

/** Whether a factory may receive the dependency at place `at` of its list. */
function receives(factory: Node | undefined, at: number): boolean {
  if (factory === undefined) {
    return false;
  }
  if (!isFunctionExpression(factory) && !isArrowFunction(factory)) {
    return true;
  }
  const { parameters } = factory;
  return at < parameters.length || parameters.some((one) => one.dotDotDotToken !== undefined);
}

/**
 * The path a dependency id names against the calling file's directory: a relative module id,
 * `./` or `../` with no `.js` ending, with `.js` appended. RequireJS reads any other id
 * through its configuration or as a URL against the page, which the analysis does not know.
 */
export function amdPath(dir: string, id: string): string | undefined {
  return startsRelativePath(id) && !id.endsWith(".js") ? resolvePath(dir, `${id}.js`) : undefined;
}

/**
 * Whether one call may load a file the analysis cannot name: a computed list, or an id that
 * RequireJS reads as a URL, one ending in `.js`, starting with `/` or carrying a scheme. Any
 * other id {@link amdPath} reads no path from is a package's.
 */
export function amdUnresolved(load: AmdLoad): boolean {
  return (
    load.computed ||
    load.ids.some(
      ({ id }) =>
        amdPath("/", id.text) === undefined &&
        (id.text.endsWith(".js") || isAbsolutePath(id.text) || hasURLScheme(id.text)),
    )
  );
}
