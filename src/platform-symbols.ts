/**
 * The platform's names read through a program's checker: its `require` and `URL`, as
 * `platform-calls.ts` decides them, its worker constructors and `navigator`, and Node's
 * `Worker`.
 */

import {
  isArrowFunction,
  isClassDeclaration,
  isClassExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isMethodDeclaration,
  isModuleDeclaration,
  isPropertyAssignment,
  isPropertyDeclaration,
  isSourceFile,
  isStringLiteralLikeNode,
  isVariableDeclaration,
  type Identifier,
  type Node,
} from "@typescript/native/ast";
import { SymbolFlags, type Symbol as TSSymbol } from "@typescript/native/sync";
import { UNANSWERED, type Answer } from "./query.ts";
import type { ProjectView } from "./session.ts";
import { boundExports, NAMESPACE } from "./entries/static-module.ts";
import { isAmbient } from "./inventory.ts";
import { callsPlatformBy, carriedNames, type BindingOf, type Bound } from "./platform-calls.ts";
import { unwrapped } from "./unwrap.ts";

/** The symbol one symbol names through its aliases, or the symbol itself where it is none. */
function dealiased<Brand>(project: ProjectView<Brand>, symbol: TSSymbol): Answer<TSSymbol> {
  if ((symbol.flags & SymbolFlags.Alias) === 0) {
    return symbol;
  }
  return project.queries.aliased(symbol);
}

/** Each declaration of `symbol` in a file of the target, read in this project's program. */
function ownDeclarations<Brand>(project: ProjectView<Brand>, symbol: TSSymbol): readonly Node[] {
  const own = project.ownPaths();
  return symbol.declarations.flatMap((handle) => {
    const node = own.has(handle.path) ? project.declarationAt(handle)?.node : undefined;
    return node === undefined ? [] : [node];
  });
}

/**
 * Whether one declaration writes a function or a class with a body (roots.23): a function
 * or method declaration with a body, a class declaration, or a variable, a property or a
 * class field whose initializer is a function, an arrow function or a class expression,
 * under no `declare` modifier and in no declaration file.
 */
function writesBody(node: Node): boolean {
  const value =
    (isVariableDeclaration(node) || isPropertyAssignment(node) || isPropertyDeclaration(node)) &&
    node.initializer !== undefined
      ? unwrapped(node.initializer)
      : node;
  return (
    (isFunctionDeclaration(value) || isMethodDeclaration(value)
      ? value.body !== undefined
      : isFunctionExpression(value) ||
        isArrowFunction(value) ||
        isClassDeclaration(value) ||
        isClassExpression(value)) && !isAmbient(value.getSourceFile(), value)
  );
}

/**
 * What the checker binds `symbol` to, one alias step at a time: every name a step of the
 * chain carries it by, and the declarations of the target its last step reaches, which
 * prove it the target's own where one {@link writesBody}. A chain that ends at no
 * declaration, or that the checker leaves unanswered, reaches none.
 */
function boundBy<Brand>(
  project: ProjectView<Brand>,
  symbol: Answer<TSSymbol> | undefined,
): Bound | undefined {
  if (typeof symbol !== "object") {
    return undefined;
  }
  const names = new Set<string>();
  const stepped = new Set<number>();
  for (let at: TSSymbol | undefined = symbol; at !== undefined && !stepped.has(at.id);) {
    stepped.add(at.id);
    names.add(at.name);
    const own = ownDeclarations(project, at);
    for (const node of own) {
      carriedNames(node).forEach((one) => names.add(one));
    }
    if ((at.flags & SymbolFlags.Alias) === 0) {
      return { names, own, provenOwn: own.some(writesBody) };
    }
    const next = project.aliasStepOf(at);
    at = typeof next === "object" ? next : undefined;
  }
  return { names, own: [], provenOwn: false };
}

/** Each written name's binding, as this project's checker answers it. */
function checkerBinding<Brand>(project: ProjectView<Brand>): BindingOf {
  return (written) => boundBy(project, project.symbolsAt([project.handle(written)])[0]);
}

/**
 * Whether a call or construction through `callee`, the batch's answer for which is `symbol`,
 * is one of the platform's `require`, AMD's `define` or `URL` (roots.23, references-ts.37,
 * references-ts.1), as {@link callsPlatformBy} decides it over this project's checker.
 */
export function callsPlatform<Brand>(
  project: ProjectView<Brand>,
  name: "require" | "define" | "URL",
  callee: Identifier,
  symbol: Answer<TSSymbol> | undefined,
): boolean {
  const others = checkerBinding(project);
  return callsPlatformBy(name, callee, (written) =>
    written === callee ? boundBy(project, symbol) : others(written),
  );
}

/**
 * Whether a worker's constructor or `navigator`, the batch's answer for which is `symbol`, is
 * the platform's (references-ts.2): a name the checker leaves unanswered, or one whose symbol
 * is no alias and has a declaration outside the target's files.
 */
export function isPlatformGlobal<Brand>(
  project: ProjectView<Brand>,
  symbol: Answer<TSSymbol> | undefined,
): boolean {
  if (symbol === UNANSWERED) {
    return true;
  }
  const own = project.ownPaths();
  return (
    symbol !== undefined &&
    (symbol.flags & SymbolFlags.Alias) === 0 &&
    symbol.declarations.some((handle) => !own.has(handle.path))
  );
}

/** The module names Node's worker threads are imported by. */
const THREADS: ReadonlySet<string> = new Set(["worker_threads", "node:worker_threads"]);

function namesThreads(node: Node | undefined): boolean {
  return node !== undefined && isStringLiteralLikeNode(node) && THREADS.has(node.text);
}

/** Whether one declaration is written in the body of `declare module "worker_threads"`. */
function inThreadsModule(node: Node): boolean {
  for (let at = node; !isSourceFile(at); at = at.parent) {
    if (isModuleDeclaration(at) && namesThreads(at.name)) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a `Worker` constructor, the batch's answer for which is `symbol`, is Node's
 * (references-ts.2): its symbol resolves to a declaration of `worker_threads`, or one of its
 * own declarations binds the module's `Worker`, or `holder`, the namespace it is read
 * through, binds the module, each binding read as {@link boundExports} reads one, which
 * decides where the module has no declaration.
 */
export function startsThread<Brand>(
  project: ProjectView<Brand>,
  symbol: Answer<TSSymbol> | undefined,
  holder: Answer<TSSymbol> | undefined,
): boolean {
  const bindingOf = checkerBinding(project);
  const declared = (one: Answer<TSSymbol> | undefined, member: string): boolean =>
    typeof one === "object" &&
    ownDeclarations(project, one).some((node) =>
      boundExports(node, (specifier) => THREADS.has(specifier), bindingOf).includes(member),
    );
  if (declared(symbol, "Worker") || declared(holder, NAMESPACE)) {
    return true;
  }
  const named = typeof symbol === "object" ? dealiased(project, symbol) : undefined;
  return (
    typeof named === "object" &&
    named.declarations.some((handle) => {
      const node = project.declarationAt(handle)?.node;
      return node !== undefined && inThreadsModule(node);
    })
  );
}
