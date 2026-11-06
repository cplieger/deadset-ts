/**
 * The files a bundler's JavaScript API builds from, read from the build scripts a
 * manifest's scripts run: the strings an options object passes as the bundler's entries.
 * A script is read without running it, so a value that is not written out, a computed
 * path or an options object built at run time among them, names nothing.
 */

import {
  isArrowFunction,
  isCallExpression,
  isConstructorDeclaration,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNewExpression,
  isSetAccessorDeclaration,
  isVariableDeclaration,
  type CallExpression,
  type Node,
  type SourceFile,
} from "@typescript/native/ast";
import { declarationOf, membersNamed, staticModule, type Value } from "./static-module.ts";
import { filesNamedBy, type ParseFile } from "./configuration-files.ts";
import type { Host } from "../host.ts";
import { ancestors, dirnamePath, isExplicitPath, relativePath, resolvePath } from "../paths.ts";
import type { SourceFiles } from "../source-files.ts";
import { bytewise } from "../text/compare.ts";
import { unwrapped } from "../unwrap.ts";
import { holdsManifest, inInstalledPackages, manifestAt } from "../fs/manifest.ts";
import { globExpression } from "../text/glob.ts";
import { pathsNamed, readCommands } from "../commands/read.ts";
import { manifestCommands } from "../roots/manifest.ts";
import { extensionOf, MODULE_EXTENSIONS } from "../extensions.ts";

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

/** One own file a build script's bundler call names as an entry. */
interface BuildEntry {
  readonly file: SourceFile;
  /** The string that named it. */
  readonly source: string;
}

/** One path an entry value writes. */
interface EntryPath {
  readonly path: string;
  /** What the script writes for it. */
  readonly text: string;
  /** Whether it is written as neither a relative nor an absolute path. */
  readonly request: boolean;
}

/** The one value an object writes last for a key, undefined where it writes none or may hide it. */
function lastMember(object: Value, key: string): Value | undefined {
  return membersNamed(object, key)?.at(-1);
}

/**
 * The path one entry value writes, read against `dir`: a literal, or a join of the
 * script's own directory and literals, read against that directory.
 */
function pathOf(value: Value, dir: string, scriptDir: string): EntryPath | undefined {
  if (value.kind === "text") {
    const { text } = value;
    const request = !isExplicitPath(text);
    return { path: resolvePath(dir, text), text, request };
  }
  if (value.kind === "directory") {
    const joined = value.segments.join("/");
    return { path: resolvePath(scriptDir, joined), text: joined, request: false };
  }
  return undefined;
}

/** The entry values one entries option writes: a value, an array of them, an object of them. */
function entryValues(value: Value): readonly Value[] {
  if (value.kind === "array") {
    return value.elements.flatMap(entryValues);
  }
  if (value.kind === "object") {
    const imported = lastMember(value, "import") ?? lastMember(value, "in");
    if (imported !== undefined) {
      return entryValues(imported);
    }
    return value.members.flatMap((member) => entryValues(member.value));
  }
  return [value];
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

/**
 * The calls one build script runs: those of its top level, and those of each function a
 * call it runs calls or passes on, as a callee, an argument or a function called where it
 * is written, a name read through to the function it declares.
 */
function runCalls(file: SourceFile, each: (call: CallExpression) => void): void {
  const ran = new Set<Node>();
  const run = (fn: Node): void => {
    if (!ran.has(fn)) {
      ran.add(fn);
      fn.forEachChild(visit);
    }
  };
  const runs = (node: Node): void => {
    const at = unwrapped(node);
    const declared = isIdentifier(at) ? declarationOf(at) : undefined;
    const fn =
      declared !== undefined && isVariableDeclaration(declared) && declared.initializer
        ? unwrapped(declared.initializer)
        : (declared ?? at);
    if (isFunction(fn)) {
      run(fn);
    }
  };
  const visit = (node: Node): void => {
    if (isFunction(node)) {
      return;
    }
    if (isCallExpression(node) || isNewExpression(node)) {
      if (isCallExpression(node)) {
        each(node);
      }
      runs(node.expression);
      for (const argument of node.arguments ?? []) {
        runs(argument);
      }
    }
    node.forEachChild(visit);
  };
  file.forEachChild(visit);
}

/** The entries every bundler call one build script runs names, read against `dir`. */
function scriptEntries(file: SourceFile, dir: string, files: SourceFiles): readonly BuildEntry[] {
  const module = staticModule(file);
  const building = new Map<CallExpression, BundlerAPI>();
  for (const api of BUNDLERS) {
    for (const one of module.calls(api.module)) {
      if (api.calls.includes(one.export)) {
        building.set(one.call, api);
      }
    }
  }
  const scriptDir = dirnamePath(file.fileName);
  const found: BuildEntry[] = [];
  runCalls(file, (call) => {
    const api = building.get(call);
    if (api === undefined) {
      return;
    }
    for (const options of module.argument(call)) {
      const entries = lastMember(options, api.option);
      const base = api.base === "" ? undefined : lastMember(options, api.base);
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

/** The modules one manifest's command strings run or name, by absolute path, each below the target root. */
function scriptModules(host: Host, root: string, dir: string): readonly string[] {
  const manifest = manifestAt(host, dir);
  const found = new Set<string>();
  for (const { command } of manifest === undefined ? [] : manifestCommands(host, dir, manifest)) {
    for (const { path } of pathsNamed(readCommands(command, dir))) {
      if (
        extensionOf(path, MODULE_EXTENSIONS) !== undefined &&
        relativePath(root, path) !== undefined &&
        !inInstalledPackages(path) &&
        host.kindOf(path) === "file"
      ) {
        found.add(path);
      }
    }
  }
  return [...found].sort(bytewise);
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
    for (const dir of ancestors(dirnamePath(file.fileName), root)) {
      if (dirs.has(dir)) {
        break;
      }
      dirs.add(dir);
    }
  }
  const found: BuildEntry[] = [];
  for (const dir of [...dirs].sort(bytewise)) {
    if (!holdsManifest(host, dir)) {
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
