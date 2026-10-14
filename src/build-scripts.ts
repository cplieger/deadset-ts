/**
 * The files a bundler's JavaScript API builds from, read from the build scripts a
 * manifest's scripts run: the strings an options object passes as the bundler's entries.
 * A script is read without running it, so a value that is not written out, a computed
 * path or an options object built at run time among them, names nothing.
 */

import {
  isArrayBindingPattern,
  isArrayLiteralExpression,
  isArrowFunction,
  isAsExpression,
  isCallExpression,
  isConstructorDeclaration,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isImportDeclaration,
  isMetaProperty,
  isMethodDeclaration,
  isNamedImports,
  isNamespaceImport,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSatisfiesExpression,
  isSetAccessorDeclaration,
  isStringLiteral,
  isVariableDeclaration,
  isVariableStatement,
  NodeFlags,
  type CallExpression,
  type Node,
  type SourceFile,
} from "@typescript/native/ast";
import { filesNamedBy, type ParseFile } from "./configuration-files.ts";
import { globExpression } from "./glob.ts";
import type { Host } from "./host.ts";
import { scriptTokens } from "./manifest.ts";
import { dirnamePath, joinPath, relativePath, resolvePath } from "./paths.ts";
import type { SourceFiles } from "./source-files.ts";

/** One bundler API: the module, the functions it exports that build, and the option naming entries. */
interface BundlerAPI {
  readonly module: string;
  /** The exported names of the building functions; `default` is the module's own value called. */
  readonly calls: readonly string[];
  /** The option whose strings name the entries, read as `entries` states. */
  readonly option: string;
  /** The option that moves the directory the entries are read against. */
  readonly base: string;
  /** Whether an entry string is a path, glob characters matching, or a module request, only a relative one naming a file. */
  readonly paths: boolean;
}

/**
 * The bundlers whose build call names its entries: esbuild resolves `entryPoints` against
 * `absWorkingDir` (https://esbuild.github.io/api/#working-directory), webpack `entry`
 * against `context` (https://webpack.js.org/configuration/entry-context/), and Rollup
 * `input` against the working directory, each the manifest's directory when its script runs.
 */
const BUNDLERS: readonly BundlerAPI[] = [
  {
    module: "esbuild",
    calls: ["build", "buildSync", "context"],
    option: "entryPoints",
    base: "absWorkingDir",
    paths: true,
  },
  { module: "webpack", calls: ["default"], option: "entry", base: "context", paths: false },
  { module: "rollup", calls: ["rollup", "watch"], option: "input", base: "", paths: true },
];

const MODULE_EXTENSION = /\.(?:js|mjs|cjs|ts|mts|cts)$/u;

const MANIFEST = "package.json";

/** One own file a build script's bundler call names as an entry. */
interface BuildEntry {
  readonly file: SourceFile;
  /** The string that named it. */
  readonly source: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The expression a wrapper that changes no value holds. */
function unwrapped(node: Node): Node {
  let at = node;
  while (isParenthesizedExpression(at) || isAsExpression(at) || isSatisfiesExpression(at)) {
    at = at.expression;
  }
  return at;
}

function literalOf(node: Node): string | undefined {
  const at = unwrapped(node);
  return isStringLiteral(at) || isNoSubstitutionTemplateLiteral(at) ? at.text : undefined;
}

/** Whether one call is `require(<module>)`. */
function requires(node: Node, module: string): boolean {
  const at = unwrapped(node);
  return (
    isCallExpression(at) &&
    isIdentifier(at.expression) &&
    at.expression.text === "require" &&
    at.arguments.length === 1 &&
    at.arguments[0] !== undefined &&
    literalOf(at.arguments[0]) === module
  );
}

/** The local names one file binds to a bundler: each building function, and the module's own value. */
interface Bindings {
  readonly functions: ReadonlySet<string>;
  readonly modules: ReadonlySet<string>;
}

function bindingsOf(file: SourceFile, api: BundlerAPI): Bindings {
  const functions = new Set<string>();
  const modules = new Set<string>();
  const building = (name: string): boolean => api.calls.includes(name);
  for (const statement of file.statements) {
    if (isImportDeclaration(statement)) {
      if (literalOf(statement.moduleSpecifier) !== api.module) {
        continue;
      }
      const clause = statement.importClause;
      if (clause?.name !== undefined) {
        (building("default") ? functions : modules).add(clause.name.text);
      }
      const named = clause?.namedBindings;
      if (named !== undefined && isNamespaceImport(named)) {
        modules.add(named.name.text);
      } else if (named !== undefined && isNamedImports(named)) {
        for (const element of named.elements) {
          if (building((element.propertyName ?? element.name).text)) {
            functions.add(element.name.text);
          }
        }
      }
    } else if (isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const { name, initializer } = declaration;
        if (initializer === undefined || !requires(initializer, api.module)) {
          continue;
        }
        if (isIdentifier(name)) {
          (building("default") ? functions : modules).add(name.text);
        } else if (isObjectBindingPattern(name)) {
          for (const element of name.elements) {
            const local = element.name;
            const key = element.propertyName ?? local;
            if (
              key !== undefined &&
              local !== undefined &&
              isIdentifier(key) &&
              isIdentifier(local) &&
              building(key.text)
            ) {
              functions.add(local.text);
            }
          }
        }
      }
    }
  }
  return { functions, modules };
}

/** Whether one call's callee is a building function of a bundler the file binds, `shadowed` naming none. */
function builds(
  callee: Node,
  api: BundlerAPI,
  bindings: Bindings,
  shadowed: ReadonlySet<string>,
): boolean {
  const at = unwrapped(callee);
  if (isIdentifier(at)) {
    return bindings.functions.has(at.text) && !shadowed.has(at.text);
  }
  if (
    !isPropertyAccessExpression(at) ||
    !isIdentifier(at.name) ||
    !api.calls.includes(at.name.text)
  ) {
    return false;
  }
  const holder = unwrapped(at.expression);
  return (
    (isIdentifier(holder) && bindings.modules.has(holder.text) && !shadowed.has(holder.text)) ||
    requires(holder, api.module)
  );
}

/** The top-level `const` initializers one file declares, by name. */
function constants(file: SourceFile): ReadonlyMap<string, Node> {
  const found = new Map<string, Node>();
  for (const statement of file.statements) {
    if (
      isVariableStatement(statement) &&
      (statement.declarationList.flags & NodeFlags.Const) !== 0
    ) {
      for (const { name, initializer } of statement.declarationList.declarations) {
        if (isIdentifier(name) && initializer !== undefined) {
          found.set(name.text, initializer);
        }
      }
    }
  }
  return found;
}

/** The value one object literal writes for one member as `name: value`. */
function member(object: Node, name: string): Node | undefined {
  if (!isObjectLiteralExpression(object)) {
    return undefined;
  }
  for (const property of object.properties) {
    if (isPropertyAssignment(property) && literalOrName(property.name) === name) {
      return property.initializer;
    }
  }
  return undefined;
}

function literalOrName(node: Node): string | undefined {
  return isIdentifier(node) ? node.text : literalOf(node);
}

/** Whether one expression is the script's own directory: `__dirname` or `import.meta.dirname`. */
function isOwnDirectory(node: Node): boolean {
  const at = unwrapped(node);
  if (isIdentifier(at)) {
    return at.text === "__dirname";
  }
  return (
    isPropertyAccessExpression(at) &&
    isMetaProperty(at.expression) &&
    isIdentifier(at.name) &&
    at.name.text === "dirname"
  );
}

/** One path an entry value writes. */
interface EntryPath {
  readonly path: string;
  /** What the script writes for it. */
  readonly text: string;
  /** Whether it is written as neither a relative nor an absolute path. */
  readonly request: boolean;
}

/**
 * The path one entry value writes, read against `dir`: a literal, or a `resolve` or
 * `join` call, of `path` or bound from it, whose first argument is the script's own
 * directory and whose others are literals.
 */
function pathOf(node: Node, dir: string, scriptDir: string): EntryPath | undefined {
  const at = unwrapped(node);
  const text = literalOf(at);
  if (text !== undefined) {
    const request = !text.startsWith("./") && !text.startsWith("../") && !text.startsWith("/");
    return { path: resolvePath(dir, text), text, request };
  }
  if (!isCallExpression(at)) {
    return undefined;
  }
  const callee = unwrapped(at.expression);
  const name = isPropertyAccessExpression(callee) ? callee.name : callee;
  if (!isIdentifier(name) || (name.text !== "resolve" && name.text !== "join")) {
    return undefined;
  }
  const [first, ...rest] = at.arguments;
  const parts = rest.map(literalOf);
  if (first === undefined || !isOwnDirectory(first) || parts.some((part) => part === undefined)) {
    return undefined;
  }
  const joined = parts.join("/");
  return { path: resolvePath(scriptDir, joined), text: joined, request: false };
}

/** The entry values one entries option writes: a value, an array of them, an object of them. */
function entryValues(node: Node): readonly Node[] {
  const at = unwrapped(node);
  if (isArrayLiteralExpression(at)) {
    return at.elements.flatMap(entryValues);
  }
  if (isObjectLiteralExpression(at)) {
    const imported = member(at, "import") ?? member(at, "in");
    if (imported !== undefined) {
      return entryValues(imported);
    }
    return at.properties.flatMap((property) =>
      isPropertyAssignment(property) ? entryValues(property.initializer) : [],
    );
  }
  return [at];
}

/** The own files one entry string names, read as `api` reads it. */
function entriesNamed(
  files: SourceFiles,
  api: BundlerAPI,
  entry: EntryPath,
): readonly SourceFile[] {
  if (!api.paths && entry.request) {
    return [];
  }
  if (api.paths && /[*?[{]/u.test(entry.text)) {
    const expression = globExpression(entry.path);
    return [...files.byName.values()].filter((file) => expression.test(file.fileName));
  }
  const dir = dirnamePath(entry.path);
  return filesNamedBy(files, dir, entry.path.slice(dir.length + 1));
}

/** Whether one node is a function, whose body runs only where something calls it. */
function isFunction(node: Node): boolean {
  return (
    isFunctionDeclaration(node) ||
    isFunctionExpression(node) ||
    isArrowFunction(node) ||
    isMethodDeclaration(node) ||
    isConstructorDeclaration(node) ||
    isGetAccessorDeclaration(node) ||
    isSetAccessorDeclaration(node)
  );
}

/** The names one binding name binds: an identifier, or each name a pattern holds. */
function boundNames(name: Node, into: Set<string>): void {
  if (isIdentifier(name)) {
    into.add(name.text);
  } else if (isObjectBindingPattern(name) || isArrayBindingPattern(name)) {
    name.forEachChild((element) => {
      const bound = (element as { readonly name?: Node }).name;
      if (bound !== undefined) {
        boundNames(bound, into);
      }
    });
  }
}

/** The names one function binds of its own: its parameters and the declarations its body holds outside nested functions. */
function ownBindings(fn: Node): ReadonlySet<string> {
  const found = new Set<string>();
  const visit = (node: Node): void => {
    if (node !== fn && isFunction(node)) {
      if (isFunctionDeclaration(node) && node.name !== undefined) {
        found.add(node.name.text);
      }
      return;
    }
    if (isVariableDeclaration(node)) {
      boundNames(node.name, found);
    }
    node.forEachChild(visit);
  };
  for (const parameter of (fn as { readonly parameters?: readonly { readonly name: Node }[] })
    .parameters ?? []) {
    boundNames(parameter.name, found);
  }
  fn.forEachChild(visit);
  return found;
}

/** The functions one file declares under a name: a function declaration, or a variable bound to a function. */
function namedFunctions(file: SourceFile): ReadonlyMap<string, readonly Node[]> {
  const found = new Map<string, Node[]>();
  const add = (name: string, fn: Node): void => {
    found.set(name, [...(found.get(name) ?? []), fn]);
  };
  const visit = (node: Node): void => {
    if (isFunctionDeclaration(node) && node.name !== undefined) {
      add(node.name.text, node);
    } else if (
      isVariableDeclaration(node) &&
      isIdentifier(node.name) &&
      node.initializer !== undefined &&
      isFunction(unwrapped(node.initializer))
    ) {
      add(node.name.text, unwrapped(node.initializer));
    }
    node.forEachChild(visit);
  };
  file.forEachChild(visit);
  return found;
}

/**
 * The calls one build script runs: those of its top level, and those of each function
 * a call it runs calls or passes on, as a callee, an argument or a function called where
 * it is written. `shadowed` is the names a function running them binds of its own, which
 * hide the file's bindings of the same names.
 */
function runCalls(
  file: SourceFile,
  each: (call: CallExpression, shadowed: ReadonlySet<string>) => void,
): void {
  const named = namedFunctions(file);
  const ran = new Set<Node>();
  const run = (fn: Node, outer: ReadonlySet<string>): void => {
    if (ran.has(fn)) {
      return;
    }
    ran.add(fn);
    const shadowed = new Set([...outer, ...ownBindings(fn)]);
    fn.forEachChild((child) => {
      visit(child, shadowed);
    });
  };
  const runs = (node: Node, shadowed: ReadonlySet<string>): void => {
    const at = unwrapped(node);
    if (isFunction(at)) {
      run(at, shadowed);
    } else if (isIdentifier(at) && !shadowed.has(at.text)) {
      for (const fn of named.get(at.text) ?? []) {
        run(fn, new Set());
      }
    }
  };
  const visit = (node: Node, shadowed: ReadonlySet<string>): void => {
    if (isFunction(node)) {
      return;
    }
    if (isCallExpression(node) || isNewExpression(node)) {
      if (isCallExpression(node)) {
        each(node, shadowed);
      }
      runs(node.expression, shadowed);
      for (const argument of node.arguments ?? []) {
        runs(argument, shadowed);
      }
    }
    node.forEachChild((child) => {
      visit(child, shadowed);
    });
  };
  file.forEachChild((child) => {
    visit(child, new Set());
  });
}

/** The entries every bundler call one build script runs names, read against `dir`. */
function scriptEntries(file: SourceFile, dir: string, files: SourceFiles): readonly BuildEntry[] {
  const found: BuildEntry[] = [];
  const declared = constants(file);
  const scriptDir = dirnamePath(file.fileName);
  const bound = BUNDLERS.map((api) => ({ api, bindings: bindingsOf(file, api) }));
  runCalls(file, (call, shadowed) => {
    for (const { api, bindings } of bound) {
      if (!builds(call.expression, api, bindings, shadowed)) {
        continue;
      }
      const [argument] = call.arguments;
      let options = argument === undefined ? undefined : unwrapped(argument);
      if (options !== undefined && isIdentifier(options)) {
        options = shadowed.has(options.text) ? undefined : declared.get(options.text);
        options = options === undefined ? undefined : unwrapped(options);
      }
      const entries = options === undefined ? undefined : member(options, api.option);
      const base = options === undefined || api.base === "" ? undefined : member(options, api.base);
      const against = base === undefined ? { path: dir } : pathOf(base, dir, scriptDir);
      if (entries === undefined || against === undefined) {
        continue;
      }
      for (const value of entryValues(entries)) {
        const named = pathOf(value, against.path, scriptDir);
        if (named === undefined) {
          continue;
        }
        for (const entry of entriesNamed(files, api, named)) {
          found.push({ file: entry, source: named.text });
        }
      }
    }
  });
  return found;
}

/** The modules one manifest's scripts run, by absolute path, each below the target root. */
function scriptModules(host: Host, root: string, dir: string): readonly string[] {
  let manifest: unknown;
  try {
    manifest = JSON.parse(host.readFile(joinPath(dir, MANIFEST)));
  } catch {
    return [];
  }
  const scripts = isRecord(manifest) ? manifest["scripts"] : undefined;
  if (!isRecord(scripts)) {
    return [];
  }
  const found = new Set<string>();
  for (const command of Object.values(scripts)) {
    if (typeof command !== "string") {
      continue;
    }
    for (const token of scriptTokens(command)) {
      const path = resolvePath(dir, token);
      if (
        MODULE_EXTENSION.test(path) &&
        relativePath(root, path) !== undefined &&
        !path.split("/").includes("node_modules") &&
        host.kindOf(path) === "file"
      ) {
        found.add(path);
      }
    }
  }
  return [...found].sort();
}

/**
 * Every own file of one project a build script names as a bundler's entry: a module a
 * script of a manifest at or above an own file runs, below the target root, read from
 * the program where it holds the module and parsed alone otherwise, where a parser is given.
 */
export function buildScriptEntries(
  host: Host,
  targetRoot: string,
  files: SourceFiles,
  parse: ParseFile | undefined,
): readonly BuildEntry[] {
  const root = resolvePath(host.workingDirectory(), targetRoot);
  const dirs = new Set<string>([root]);
  for (const file of files.byName.values()) {
    for (
      let dir = dirnamePath(file.fileName);
      relativePath(root, dir) !== undefined && !dirs.has(dir);
      dir = dirnamePath(dir)
    ) {
      dirs.add(dir);
    }
  }
  const found: BuildEntry[] = [];
  for (const dir of [...dirs].sort()) {
    if (host.kindOf(joinPath(dir, MANIFEST)) !== "file") {
      continue;
    }
    for (const path of scriptModules(host, root, dir)) {
      let script = files.byName.get(path);
      if (script === undefined && parse !== undefined) {
        try {
          script = parse(path, host.readFile(path));
        } catch {
          continue;
        }
      }
      if (script !== undefined) {
        found.push(...scriptEntries(script, dir, files));
      }
    }
  }
  return found;
}
