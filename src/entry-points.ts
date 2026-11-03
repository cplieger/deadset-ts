/**
 * The files a tool or the platform enters without any import naming them, each by a name
 * the tool looks for or a literal it reads. A value that is not a literal is not evaluated
 * or guessed, so a file it would have named is entered by nothing here.
 */

import {
  isArrayLiteralExpression,
  isCallExpression,
  isExportAssignment,
  isIdentifier,
  isMetaProperty,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isStringLiteral,
  type Node,
  type SourceFile,
} from "@typescript/native/ast";
import { SymbolFlags } from "@typescript/native/sync";
import {
  configurationFiles,
  filesNamedBy,
  moduleStrings,
  type ParseFile,
} from "./configuration-files.ts";
import type { Selected } from "./conventions.ts";
import { buildScriptEntries } from "./build-scripts.ts";
import type { Host } from "./host.ts";
import { htmlEntries } from "./html-entries.ts";
import { documentEntries } from "./mdx-entries.ts";
import { hasOwnBody } from "./own-body.ts";
import { dirnamePath, relativePath, resolvePath } from "./paths.ts";
import { UNANSWERED } from "./query.ts";
import type { ProjectView } from "./session.ts";
import type { SourceFiles } from "./source-files.ts";
import { workflowEntries } from "./workflow-steps.ts";
import { unwrapped } from "./unwrap.ts";
import { globExpression } from "./text/glob.ts";

/** Which rule entered a file. */
export type EntryRule =
  /** A configuration module, by the form of its name. */
  | "configuration-file"
  /** A file a relative string of a configuration module or a JSON configuration file names. */
  | "configuration-string"
  /** An entry a build script's bundler call names, whose exports the bundle exposes. */
  | "bundler-entry"
  /** The test runner: its workspace configuration, its setup files and the test files. */
  | "test-runner"
  /** The test files below the browser-test runner's test directory. */
  | "browser-tests"
  /** A worker or service worker a call addresses by a string literal. */
  | "worker"
  /** A file a module script of an HTML file below the target root loads. */
  | "html-entry"
  /** A file a `run:` step of a workflow in the target root's `.github/workflows` names. */
  | "workflow-step"
  /** A file an import line of a Markdown or MDX document below the target root names. */
  | "document-import";

/** One file a rule enters. */
interface EntryPoint {
  readonly file: SourceFile;
  readonly rule: EntryRule;
  /**
   * What named the file: the file-name convention the tool looks for, the test-file
   * pattern that classified it, or the literal a configuration or a call writes.
   */
  readonly source: string;
  /**
   * Whether what the file exports is read too. A tool loading a configuration reads
   * its default export; a runtime executing a test file or a worker runs its top
   * level and names none of its exports.
   */
  readonly exports: boolean;
  /** Where the file is entered for some of its exports only, their export names. */
  readonly names?: readonly string[];
}

/** One file-name convention: the stems a tool looks for, under each extension it loads. */
interface Convention {
  readonly rule: EntryRule;
  readonly stems: readonly string[];
  readonly extensions: readonly string[];
  /** Whether the file is a test-runner configuration whose setup files are read. */
  readonly testRunner: boolean;
}

/** The extensions the test runner and the browser-test runner load a configuration from. */
const MODULE_EXTENSIONS = ["js", "mjs", "cjs", "ts", "mts", "cts"] as const;

/** The tool file names the configuration form does not cover. */
const CONVENTIONS: readonly Convention[] = [
  {
    rule: "test-runner",
    stems: ["vitest.workspace", "vitest.projects"],
    extensions: MODULE_EXTENSIONS,
    testRunner: true,
  },
];

/** The stem of the browser-test runner's configuration, whose test directory is read. */
const BROWSER_TEST_CONFIG = "playwright.config";

/** The browser-test runner's own test-file pattern, which holds where a configuration names none. */
const BROWSER_TEST_MATCH = "**/*.{spec,test}.{js,ts,jsx,tsx,cjs,cts,cjsx,ctsx,mjs,mts,mjsx,mtsx}";

/** The members of a test-runner configuration's `test` object that name setup files. */
const SETUP_MEMBERS = ["setupFiles", "globalSetup"] as const;

/** A member that moves the directory every path of a test-runner configuration is read from. */
const ROOT_MEMBER = "root";

/**
 * A URL reference's scheme. A reference with none that does not start with a solidus is
 * relative, the bare name included: https://url.spec.whatwg.org/#relative-url-string
 */
const URL_SCHEME = /^[a-z][a-z\d+.-]*:/iu;

/** The constructors whose first argument addresses a worker script. */
const WORKER_CONSTRUCTORS: ReadonlySet<string> = new Set(["Worker", "SharedWorker"]);

/** The file's name, the last segment of its path. */
function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** The convention one file name is, with the spelling a root reports it by. */
function conventionOf(
  name: string,
): { readonly convention: Convention; readonly spelled: string } | undefined {
  for (const convention of CONVENTIONS) {
    for (const stem of convention.stems) {
      if (convention.extensions.some((ext) => name === `${stem}.${ext}`)) {
        return { convention, spelled: `${stem}.*` };
      }
    }
  }
  return undefined;
}

/** The text a string literal or a template with no substitution denotes. */
function literalOf(node: Node | undefined): string | undefined {
  if (node !== undefined && (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node))) {
    return node.text;
  }
  return undefined;
}

/**
 * The object literals one configuration file's default export is written as: the
 * literal itself, or each literal argument of the call it is, at any depth of calls.
 * A default export written as anything else, a name or a computation, yields none,
 * because its value is not in the file's text.
 */
function configObjects(file: SourceFile): readonly Node[] {
  const found: Node[] = [];
  const collect = (node: Node): void => {
    const at = unwrapped(node);
    if (isObjectLiteralExpression(at)) {
      found.push(at);
      return;
    }
    if (isCallExpression(at)) {
      for (const argument of at.arguments) {
        collect(argument);
      }
    }
  };
  for (const statement of file.statements) {
    if (isExportAssignment(statement) && !statement.isExportEquals) {
      collect(statement.expression);
    }
  }
  return found;
}

/**
 * The value one member of an object literal is written with, when it is written as
 * `name: value`, and undefined where the literal writes no such member.
 */
function memberOf(object: Node, name: string): Node | undefined {
  if (!isObjectLiteralExpression(object)) {
    return undefined;
  }
  for (const property of object.properties) {
    if (
      isPropertyAssignment(property) &&
      isIdentifier(property.name) &&
      property.name.text === name
    ) {
      return property.initializer;
    }
  }
  return undefined;
}

/**
 * The strings one member holds, when it is written as a literal or an array of
 * literals. `undefined` is a value the text does not state.
 */
export function literalsOf(value: Node): readonly string[] | undefined {
  const at = unwrapped(value);
  const single = literalOf(at);
  if (single !== undefined) {
    return [single];
  }
  if (!isArrayLiteralExpression(at)) {
    return undefined;
  }
  const found: string[] = [];
  for (const element of at.elements) {
    const text = literalOf(unwrapped(element));
    if (text === undefined) {
      return undefined;
    }
    found.push(text);
  }
  return found;
}

/**
 * Whether a literal is a relative URL reference, which is also how the test runner reads a
 * setup file's path against its root.
 */
function isRelative(text: string): boolean {
  return text !== "" && !text.startsWith("/") && !URL_SCHEME.test(text);
}

/** A URL reference with its query and its fragment removed, which name no part of the file. */
function pathPart(text: string): string {
  const cut = text.search(/[?#]/u);
  return cut < 0 ? text : text.slice(0, cut);
}

/** The own files one relative literal names, read against a directory. */
function filesNamed(files: SourceFiles, dir: string, text: string): readonly SourceFile[] {
  if (!isRelative(text)) {
    return [];
  }
  return files.named(resolvePath(dir, pathPart(text)));
}

/** Whether one file name is the browser-test runner's configuration. */
function isBrowserTestConfig(name: string): boolean {
  return MODULE_EXTENSIONS.some((ext) => name === `${BROWSER_TEST_CONFIG}.${ext}`);
}

/**
 * The files the configuration files of one project enter: each configuration module,
 * with what it exports, and each own file a relative string of a configuration module
 * or a JSON configuration file names, read against that file's directory. A string at a
 * selection key of an applied convention row names no file.
 */
function configurationEntries(
  host: Host,
  targetRoot: string,
  files: SourceFiles,
  parse: ParseFile | undefined,
  selected: ReadonlyMap<string, Selected>,
): readonly EntryPoint[] {
  const { modules, documents, outside } = configurationFiles(host, targetRoot, files, parse);
  const found: EntryPoint[] = [];
  const unselected = (file: SourceFile): readonly string[] => {
    const starts = selected.get(file.fileName)?.starts;
    return moduleStrings(file)
      .filter((one) => starts?.has(one.node.getStart()) !== true)
      .map((one) => one.text);
  };
  const unselectedIn = (path: string, texts: readonly string[]): readonly string[] => {
    const left = [...(selected.get(path)?.texts ?? [])];
    return texts.filter((text) => {
      const at = left.indexOf(text);
      if (at < 0) {
        return true;
      }
      left.splice(at, 1);
      return false;
    });
  };
  const strings = (dir: string, texts: readonly string[]): void => {
    for (const text of texts) {
      for (const file of filesNamedBy(files, dir, text)) {
        found.push({ file, rule: "configuration-string", source: text, exports: true });
      }
    }
  };
  for (const { file, form } of modules) {
    found.push({ file, rule: "configuration-file", source: form, exports: true });
    strings(dirnamePath(file.fileName), unselected(file));
  }
  for (const document of documents) {
    strings(dirnamePath(document.path), unselectedIn(document.path, document.strings));
  }
  for (const { file } of outside) {
    strings(dirnamePath(file.fileName), unselected(file));
  }
  return found;
}

/**
 * The setup files one test-runner configuration names: every literal under
 * `test.setupFiles` and `test.globalSetup`, read against the configuration's own
 * directory. A configuration that moves its root names them against a directory its
 * text may not state, so none is read from it.
 */
function setupFilesOf(file: SourceFile, files: SourceFiles): readonly EntryPoint[] {
  const objects = configObjects(file);
  const tests = objects
    .map((object) => memberOf(object, "test"))
    .filter((value): value is Node => value !== undefined)
    .map(unwrapped);
  if ([...objects, ...tests].some((object) => memberOf(object, ROOT_MEMBER) !== undefined)) {
    return [];
  }
  const dir = dirnamePath(file.fileName);
  const found: EntryPoint[] = [];
  for (const test of tests) {
    for (const name of SETUP_MEMBERS) {
      const value = memberOf(test, name);
      for (const text of value === undefined ? [] : (literalsOf(value) ?? [])) {
        for (const named of filesNamed(files, dir, text)) {
          found.push({ file: named, rule: "test-runner", source: text, exports: false });
        }
      }
    }
  }
  return found;
}

/**
 * The test files one browser-test configuration names: every own file below its
 * test directory that its test-file pattern matches. The directory is the literal
 * `testDir` reads against the configuration's directory, or that directory where no
 * object of the configuration writes one; the pattern is the literal `testMatch`, or
 * the runner's own where none is written. A member whose value is not a literal
 * leaves the set unknown, and an unknown set enters nothing.
 */
function browserTestsOf(file: SourceFile, files: SourceFiles): readonly EntryPoint[] {
  const objects = configObjects(file);
  if (objects.length === 0) {
    return [];
  }
  let testDir: string | undefined = ".";
  let patterns: readonly string[] | undefined = [BROWSER_TEST_MATCH];
  for (const object of objects) {
    const dir = memberOf(object, "testDir");
    if (dir !== undefined) {
      testDir = literalOf(unwrapped(dir));
    }
    const match = memberOf(object, "testMatch");
    if (match !== undefined) {
      patterns = literalsOf(match);
    }
  }
  if (testDir === undefined || patterns === undefined) {
    return [];
  }
  const under = resolvePath(dirnamePath(file.fileName), testDir);
  const found: EntryPoint[] = [];
  for (const pattern of patterns) {
    const expression = globExpression(pattern);
    for (const candidate of files.byName.values()) {
      const below = relativePath(under, candidate.fileName);
      if (below !== undefined && expression.test(below)) {
        found.push({ file: candidate, rule: "browser-tests", source: pattern, exports: false });
      }
    }
  }
  return found;
}

/** One call that addresses a worker, with the names the checker must resolve to the platform. */
interface WorkerSite {
  readonly literal: string;
  readonly platformNames: readonly Node[];
  /** The `URL` the address is built with; {@link hasOwnBody} owns which one names no file. */
  readonly url: Node | undefined;
}

/**
 * The address one worker argument writes: a relative literal, or a `URL` built from
 * a literal against `import.meta.url`. Any other argument is computed and addresses
 * nothing the text states.
 */
function workerAddress(
  argument: Node | undefined,
): { readonly literal: string; readonly url: Node | undefined } | undefined {
  if (argument === undefined) {
    return undefined;
  }
  const at = unwrapped(argument);
  const literal = literalOf(at);
  if (literal !== undefined) {
    return { literal, url: undefined };
  }
  if (!isNewExpression(at) || !isIdentifier(at.expression) || at.expression.text !== "URL") {
    return undefined;
  }
  const [reference, base] = at.arguments ?? [];
  const text = literalOf(reference === undefined ? undefined : unwrapped(reference));
  if (text === undefined || base === undefined) {
    return undefined;
  }
  const meta = unwrapped(base);
  if (
    !isPropertyAccessExpression(meta) ||
    !isMetaProperty(meta.expression) ||
    !isIdentifier(meta.name) ||
    meta.name.text !== "url"
  ) {
    return undefined;
  }
  return { literal: text, url: at.expression };
}

/**
 * Every call one file writes that addresses a worker: `new Worker(...)`,
 * `new SharedWorker(...)` and `navigator.serviceWorker.register(...)`, each with an
 * address its text states.
 */
function workerSitesOf(file: SourceFile): readonly WorkerSite[] {
  const found: WorkerSite[] = [];
  const visit = (node: Node): void => {
    if (
      isNewExpression(node) &&
      isIdentifier(node.expression) &&
      WORKER_CONSTRUCTORS.has(node.expression.text)
    ) {
      const address = workerAddress(node.arguments?.[0]);
      if (address !== undefined) {
        found.push({
          literal: address.literal,
          platformNames: [node.expression],
          url: address.url,
        });
      }
    }
    if (isCallExpression(node)) {
      const callee = node.expression;
      if (
        isPropertyAccessExpression(callee) &&
        isIdentifier(callee.name) &&
        callee.name.text === "register" &&
        isPropertyAccessExpression(callee.expression) &&
        isIdentifier(callee.expression.name) &&
        callee.expression.name.text === "serviceWorker" &&
        isIdentifier(callee.expression.expression) &&
        callee.expression.expression.text === "navigator"
      ) {
        const address = workerAddress(node.arguments[0]);
        if (address !== undefined) {
          found.push({
            literal: address.literal,
            platformNames: [callee.expression.expression],
            url: address.url,
          });
        }
      }
    }
    node.forEachChild(visit);
  };
  file.forEachChild(visit);
  return found;
}

/**
 * The workers one file addresses. A call's `Worker`, `SharedWorker` or `navigator` must
 * resolve to a symbol the platform declares, which a file of the target may augment and no
 * import brings in; a name only the target declares is the target's own constructor or
 * object, which addresses no worker this rule knows. One batch per file that writes such a call.
 */
function workersOf<Brand>(
  project: ProjectView<Brand>,
  file: SourceFile,
  files: SourceFiles,
): readonly EntryPoint[] {
  const sites = workerSitesOf(file);
  if (sites.length === 0) {
    return [];
  }
  const names = sites.flatMap((site) => site.platformNames);
  const urls = sites.flatMap((site) => site.url ?? []);
  const symbols = project.symbolsAt([...names, ...urls].map((name) => project.handle(name)));
  const platform = new Set<Node>();
  // A name the checker could not resolve is read as the platform's, so a worker it
  // stands on is rooted rather than reported.
  names.forEach((name, index) => {
    const symbol = symbols[index];
    if (symbol === UNANSWERED) {
      platform.add(name);
      return;
    }
    if (
      symbol !== undefined &&
      (symbol.flags & SymbolFlags.Alias) === 0 &&
      symbol.declarations.some((handle) => !files.byName.has(handle.path))
    ) {
      platform.add(name);
    }
  });
  urls.forEach((url, index) => {
    const symbol = symbols[names.length + index];
    if (typeof symbol !== "object" || !hasOwnBody(project, symbol)) {
      platform.add(url);
    }
  });
  const dir = dirnamePath(file.fileName);
  const found: EntryPoint[] = [];
  for (const site of sites) {
    if (
      !site.platformNames.every((name) => platform.has(name)) ||
      (site.url !== undefined && !platform.has(site.url))
    ) {
      continue;
    }
    for (const named of filesNamed(files, dir, site.literal)) {
      found.push({ file: named, rule: "worker", source: site.literal, exports: false });
    }
  }
  return found;
}

/**
 * Every file of one project the rules enter, in no particular order and possibly more
 * than once: a file two rules enter appears once per rule.
 *
 * `testFiles` is the configuration's test-file patterns, matched against each
 * file's path below the target root; a file one of them matches is a test file the
 * runner executes.
 */
export function entryPoints<Brand>(
  project: ProjectView<Brand>,
  files: SourceFiles,
  testFiles: readonly string[],
  host: Host,
  targetRoot: string,
  parse?: ParseFile,
  selected: ReadonlyMap<string, Selected> = new Map(),
): readonly EntryPoint[] {
  const found: EntryPoint[] = [...configurationEntries(host, targetRoot, files, parse, selected)];
  const tests = testFiles.map((pattern) => ({ pattern, expression: globExpression(pattern) }));
  for (const [path, file] of files.byPath) {
    const name = basename(path);
    const named = conventionOf(name);
    if (named !== undefined) {
      found.push({ file, rule: named.convention.rule, source: named.spelled, exports: true });
      if (named.convention.testRunner) {
        found.push(...setupFilesOf(file, files));
      }
    }
    if (isBrowserTestConfig(name)) {
      found.push(...browserTestsOf(file, files));
    }
    for (const { pattern, expression } of tests) {
      if (expression.test(path)) {
        found.push({ file, rule: "test-runner", source: pattern, exports: false });
      }
    }
    found.push(...workersOf(project, file, files));
  }
  for (const { file, source } of htmlEntries(host, targetRoot, files, parse)) {
    found.push({ file, rule: "html-entry", source, exports: true });
  }
  for (const { file, source, names } of documentEntries(host, targetRoot, files)) {
    found.push({
      file,
      rule: "document-import",
      source,
      exports: true,
      ...(names === undefined ? {} : { names }),
    });
  }
  for (const { file, source } of buildScriptEntries(host, targetRoot, files, parse)) {
    found.push({ file, rule: "bundler-entry", source, exports: true });
  }
  for (const { file, source } of workflowEntries(host, targetRoot, files)) {
    found.push({ file, rule: "workflow-step", source, exports: true });
  }
  return found;
}
