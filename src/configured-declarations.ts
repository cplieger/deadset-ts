/**
 * The declarations the configuration's entries name, resolved in one project, and
 * which of them a symbol is. Declarations are compared rather than symbols, because a
 * member read through an instantiation of a generic type is a symbol of its own that
 * keeps the declarations of the member it instantiates.
 */

import {
  isCallExpression,
  isExportDeclaration,
  isExternalModuleReference,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isNoSubstitutionTemplateLiteral,
  isStringLiteral,
  SyntaxKind,
  type Node,
} from "@typescript/native/unstable/ast";
import {
  SymbolFlags,
  type NodeHandle,
  type Symbol as TSSymbol,
} from "@typescript/native/unstable/sync";
import type { AliasChains } from "./alias-chain.ts";
import { resolvedTargets } from "./calls.ts";
import type { DeclarationEntry } from "./config.ts";
import type { Inventory } from "./inventory.ts";
import { nameComponent } from "./ref.ts";
import type { ProjectView } from "./session.ts";

/** The meanings a name of the global scope is looked up under: any of them. */
const ANY_MEANING: SymbolFlags = SymbolFlags.Value | SymbolFlags.Type | SymbolFlags.Namespace;

/** The suffix that marks a static member at the end of a path. */
const STATIC = ":static";

/**
 * One entry and the declaration it names in one project. Both sets are empty where
 * the entry names no declaration there, which is how an entry that names nothing is
 * told from one that names something no call reaches.
 */
export interface ResolvedEntry {
  readonly entry: DeclarationEntry;
  /** The declarations a module or global entry resolves to, each as its handle's key. */
  readonly handles: ReadonlySet<string>;
  /** The inventory's identifier of the declaration a symbol entry names. */
  readonly ids: ReadonlySet<string>;
}

/** The key one declaration handle is compared by: its file and its index in that file. */
function handleKey(handle: NodeHandle): string {
  return `${handle.path}:${String(handle.index)}`;
}

/**
 * The components of one declaration path and whether its last one is a static member.
 * A path is split at the dots outside a quoted or a bracketed component, and each
 * component keeps the spelling a reference gives it.
 */
function componentsOf(path: string): { readonly components: string[]; readonly static: boolean } {
  const isStatic = path.endsWith(STATIC);
  const body = isStatic ? path.slice(0, -STATIC.length) : path;
  const components: string[] = [];
  let current = "";
  let closing = "";
  for (let at = 0; at < body.length; at += 1) {
    const ch = body.charAt(at);
    if (closing === "'" && ch === "\\") {
      current += ch + body.charAt(at + 1);
      at += 1;
      continue;
    }
    if (closing !== "") {
      closing = ch === closing ? "" : closing;
    } else if (ch === "'" || ch === "[") {
      closing = ch === "'" ? "'" : "]";
    } else if (ch === ".") {
      components.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  components.push(current);
  return { components, static: isStatic };
}

/** What a symbol is once every alias it stands for is followed. */
function unaliased<Brand>(project: ProjectView<Brand>, symbol: TSSymbol): TSSymbol | undefined {
  if ((symbol.flags & SymbolFlags.Alias) === 0) {
    return symbol;
  }
  const target = project.checker.getAliasedSymbol(symbol);
  return target.declarations.length === 0 ? undefined : target;
}

/** Whether one symbol is a member a class declares: a property, a method or an accessor. */
function isClassMember(symbol: TSSymbol): boolean {
  return (symbol.flags & SymbolFlags.ClassMember) !== 0;
}

/**
 * The members of one container a path component may name. A class keeps its static
 * members among its exports beside what a merged namespace exports, so a component
 * with the static suffix names one of the first and a component without it names an
 * instance member or one of the second.
 */
function candidatesOf(container: TSSymbol, isStatic: boolean): readonly TSSymbol[] {
  const exported = [...container.getExports().values()];
  if (isStatic) {
    return exported.filter(isClassMember);
  }
  const isClass = (container.flags & SymbolFlags.Class) !== 0;
  return [
    ...container.getMembers().values(),
    ...exported.filter((member) => !isClass || !isClassMember(member)),
  ];
}

/** The member of one container a path component spells, followed through any alias. */
function memberOf<Brand>(
  project: ProjectView<Brand>,
  container: TSSymbol,
  component: string,
  isStatic: boolean,
): TSSymbol | undefined {
  const member = candidatesOf(container, isStatic).find(
    (candidate) => nameComponent(candidate.name) === component,
  );
  return member === undefined ? undefined : unaliased(project, member);
}

/** The declaration a path names from one starting symbol, component by component. */
function walkPath<Brand>(
  project: ProjectView<Brand>,
  start: TSSymbol | undefined,
  rest: readonly string[],
  isStatic: boolean,
): TSSymbol | undefined {
  let at = start;
  rest.forEach((component, index) => {
    if (at !== undefined) {
      at = memberOf(project, at, component, isStatic && index === rest.length - 1);
    }
  });
  return at;
}

/** Whether one node is literal text: a string literal or a template with no substitution. */
function isLiteralText(node: Node | undefined): node is Node & { readonly text: string } {
  return node !== undefined && (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node));
}

/** The module specifier one node writes, for each form that imports or re-exports a module. */
function specifierOf(node: Node): Node | undefined {
  if (isImportDeclaration(node) || isExportDeclaration(node)) {
    return node.moduleSpecifier;
  }
  if (isImportEqualsDeclaration(node) && isExternalModuleReference(node.moduleReference)) {
    return node.moduleReference.expression;
  }
  if (isCallExpression(node) && node.expression.kind === SyntaxKind.ImportKeyword) {
    return node.arguments[0];
  }
  return undefined;
}

/**
 * The module each specifier the entries name resolves to in one project, read from a
 * specifier the project's own files write, so the module is the one the target's own
 * import resolves. A specifier no file writes resolves to no module.
 */
function modulesNamed<Brand>(
  project: ProjectView<Brand>,
  specifiers: ReadonlySet<string>,
): ReadonlyMap<string, TSSymbol> {
  const written = new Map<string, Node>();
  for (const file of project.ownSourceFiles()) {
    const visit = (node: Node): void => {
      const specifier = specifierOf(node);
      if (
        isLiteralText(specifier) &&
        specifiers.has(specifier.text) &&
        !written.has(specifier.text)
      ) {
        written.set(specifier.text, specifier);
      }
      node.forEachChild(visit);
    };
    file.forEachChild(visit);
  }
  const specified = [...written];
  const symbols = project.symbolsAt(specified.map(([, node]) => project.handle(node)));
  const modules = new Map<string, TSSymbol>();
  specified.forEach(([name], index) => {
    const symbol = symbols[index];
    if (symbol !== undefined) {
      modules.set(name, symbol);
    }
  });
  return modules;
}

/**
 * The declaration each entry names in one project. A symbol entry names the
 * inventory's declaration whose reference it spells exactly; a module entry names the
 * declaration its path reaches from the exports of the module its specifier resolves
 * to; a global entry names the declaration its path reaches from the global scope.
 * Every alias along a path is followed to the declaration it stands for.
 */
export function resolveEntries<Brand>(
  project: ProjectView<Brand>,
  held: Inventory,
  entries: readonly DeclarationEntry[],
): readonly ResolvedEntry[] {
  if (entries.length === 0) {
    return [];
  }
  const byRef = new Map(held.symbols.map((symbol) => [symbol.ref, symbol.id]));
  const modules = modulesNamed(
    project,
    new Set(entries.flatMap((entry) => (entry.shape === "module" ? [entry.module] : []))),
  );
  return entries.map((entry) => {
    if (entry.shape === "symbol") {
      const id = byRef.get(entry.symbol);
      return { entry, handles: new Set<string>(), ids: new Set(id === undefined ? [] : [id]) };
    }
    const { components, static: isStatic } = componentsOf(
      entry.shape === "module" ? entry.name : entry.global,
    );
    const [first = "", ...rest] = components;
    let start: TSSymbol | undefined;
    if (isStatic && rest.length === 0) {
      // Only a member is static, and a path of one component names no member.
      start = undefined;
    } else if (entry.shape === "module") {
      const module = modules.get(entry.module);
      start = module === undefined ? undefined : memberOf(project, module, first, false);
    } else if (nameComponent(first) === first) {
      const global = project.checker.resolveName(first, ANY_MEANING, undefined, false);
      start = global === undefined ? undefined : unaliased(project, global);
    }
    const declared = walkPath(project, start, rest, isStatic);
    return {
      entry,
      handles: new Set(declared?.declarations.map(handleKey) ?? []),
      ids: new Set<string>(),
    };
  });
}

/**
 * Whether one symbol is the declaration a resolved entry names: it shares one of the
 * entry's declarations, or, for an entry naming a declaration of the program, it is
 * declared there. `chains` reads the symbol's declarations against the inventory the
 * entries were resolved with.
 */
export function names(resolved: ResolvedEntry, symbol: TSSymbol, chains: AliasChains): boolean {
  if (symbol.declarations.some((handle) => resolved.handles.has(handleKey(handle)))) {
    return true;
  }
  return resolved.ids.size > 0 && chains.declarationsOf(symbol).some((id) => resolved.ids.has(id));
}

/** Whether a resolved entry names a declaration, so that some symbol can be it. */
export function namesADeclaration(resolved: ResolvedEntry): boolean {
  return resolved.handles.size > 0 || resolved.ids.size > 0;
}

/**
 * The entries each of a batch of name nodes is: what the node resolves to, every alias
 * followed, is the declaration each of them names. A node that is none is absent.
 */
export function entriesAt<Brand>(
  project: ProjectView<Brand>,
  chains: AliasChains,
  nodes: readonly Node[],
  resolved: readonly ResolvedEntry[],
): ReadonlyMap<Node, readonly ResolvedEntry[]> {
  const naming = resolved.filter(namesADeclaration);
  const found = new Map<Node, readonly ResolvedEntry[]>();
  if (naming.length === 0) {
    return found;
  }
  for (const [node, target] of resolvedTargets(project, nodes)) {
    const entries = naming.filter((entry) => names(entry, target, chains));
    if (entries.length > 0) {
      found.set(node, entries);
    }
  }
  return found;
}

/**
 * How one entry is spelled in a record's detail: its path, or for a declaration of the
 * program the display name the inventory gives it.
 */
export function spelledEntry(entry: DeclarationEntry, held: Inventory): string {
  switch (entry.shape) {
    case "symbol":
      return held.symbols.find((symbol) => symbol.ref === entry.symbol)?.name ?? entry.symbol;
    case "module":
      return entry.name;
    case "global":
      return entry.global;
  }
}
