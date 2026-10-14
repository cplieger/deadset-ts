/**
 * Test-support code: the files only tests reach that carry test evidence of their own. A
 * test reaches each one through a chain of references, and every reference to a
 * declaration of one, an import for its effects included, is written in a test file or in
 * another such file, so it is judged with the tests: what it references is referenced by
 * test code.
 */

import { CONVENTION_ROWS, TEST_LIBRARIES, TEST_LIBRARY_SCOPES } from "./convention-rows.ts";
import { packageOfSpecifier } from "./dependencies.ts";
import type { InventorySymbol } from "./inventory.ts";
import type { Reference } from "./references.ts";
import type { Root } from "./roots.ts";

/** The root kind that never takes a file out of test-support code: the skip only withholds. */
const SKIP_ROOT = "type-error";

/**
 * The test runners and test libraries an import of which is test evidence: each runner a
 * convention row reads test files for, and the convention table's test libraries.
 */
const TEST_PACKAGES: ReadonlySet<string> = new Set([
  ...CONVENTION_ROWS.filter((row) => row.testFiles !== undefined).map((row) => row.package),
  ...TEST_LIBRARIES,
]);

/**
 * The Node.js built-in modules a bare specifier names, which are no package. The set is
 * closed: Node.js adds a new built-in under the `node:` scheme alone
 * (https://nodejs.org/api/modules.html#built-in-modules-with-mandatory-node-prefix).
 */
const NODE_BUILTINS: ReadonlySet<string> = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "sys",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
]);

/** What a file imports, read for test evidence. */
export interface TestEvidence {
  /** Per file below the target root, the module specifiers its imports write. */
  readonly imports: ReadonlyMap<string, readonly string[]>;
  /**
   * Whether the manifest nearest the file, below the target root, that declares the
   * package declares it under `devDependencies`.
   */
  readonly devDependency: (path: string, name: string) => boolean;
}

/** Whether a specifier names a test runner or a test library. */
function namesTestPackage(specifier: string): boolean {
  const name = specifier.startsWith("node:") ? specifier : packageOfSpecifier(specifier);
  return (
    name !== undefined &&
    (TEST_PACKAGES.has(name) || TEST_LIBRARY_SCOPES.some((scope) => name.startsWith(scope)))
  );
}

/**
 * Whether a file carries test evidence: an import of a test runner or a test library, or
 * package imports, Node built-ins aside, that are all devDependencies no file imports
 * outside the test files and `onlyTests`, the files only tests reach.
 */
function evidenceReader(
  tests: ReadonlySet<string>,
  evidence: TestEvidence,
): (onlyTests: ReadonlySet<string>, path: string) => boolean {
  const importers = new Map<string, string[]>();
  for (const [path, specifiers] of evidence.imports) {
    for (const specifier of specifiers) {
      const name = packageOfSpecifier(specifier);
      if (name !== undefined) {
        importers.set(name, [...(importers.get(name) ?? []), path]);
      }
    }
  }
  return (onlyTests, path) => {
    const specifiers = evidence.imports.get(path) ?? [];
    if (specifiers.some(namesTestPackage)) {
      return true;
    }
    const names = specifiers.flatMap((one) => packageOfSpecifier(one) ?? []);
    const packages = names.filter((name) => !NODE_BUILTINS.has(name));
    return (
      packages.length > 0 &&
      packages.every(
        (name) =>
          evidence.devDependency(path, name) &&
          (importers.get(name) ?? []).every((one) => tests.has(one) || onlyTests.has(one)),
      )
    );
  };
}

/** The files only tests reach, split by whether each carries test evidence of its own. */
interface TestReached {
  /** The test-support files: test code. */
  readonly support: ReadonlySet<string>;
  /** The files only tests reach that are no test-support file: production code only tests use. */
  readonly testUsed: ReadonlySet<string>;
}

/**
 * The files of one project that are test-support code, below the target root: the
 * largest set of files a test file reaches, none of them a test file or holding a root,
 * each carrying test evidence of its own, whose every user outside the set is a test
 * file; and the files only tests reach that are not among them. A root has a caller
 * outside the reference graph: a runtime, a tool, a configuration, or a consumer of a
 * library's published API. `testFiles` are the files the test-file rules classified.
 */
export function testSupportFiles(
  symbols: readonly InventorySymbol[],
  references: readonly Reference[],
  roots: readonly Root[],
  testFiles: readonly string[],
  evidence: TestEvidence,
): TestReached {
  const fileOf = new Map(symbols.map((symbol) => [symbol.id, symbol.position.path]));
  const users = new Map<string, Set<string>>();
  const uses = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, key: string, value: string): void => {
    const held = map.get(key);
    if (held === undefined) {
      map.set(key, new Set([value]));
    } else {
      held.add(value);
    }
  };
  for (const reference of references) {
    const used = fileOf.get(reference.to);
    const from = reference.position.path;
    if (reference.consumer !== undefined || used === undefined || used === from) {
      continue;
    }
    add(users, used, from);
    add(uses, from, used);
  }
  const tests = new Set(testFiles);
  const rooted = new Set(
    roots.filter((root) => root.kind !== SKIP_ROOT).flatMap((root) => fileOf.get(root.id) ?? []),
  );
  const reached = new Set<string>();
  const queue = [...tests];
  for (let path = queue.pop(); path !== undefined; path = queue.pop()) {
    for (const next of uses.get(path) ?? []) {
      if (!reached.has(next) && !tests.has(next)) {
        reached.add(next);
        queue.push(next);
      }
    }
  }
  const withoutOutsideUsers = (files: Set<string>): Set<string> => {
    for (let changed = true; changed;) {
      changed = false;
      for (const path of files) {
        const from = users.get(path) ?? new Set<string>();
        if (![...from].every((one) => tests.has(one) || files.has(one))) {
          files.delete(path);
          changed = true;
        }
      }
    }
    return files;
  };
  // Evidence reads the files only tests reach, evidence or none, so it is fixed before the
  // files without evidence leave the set.
  const onlyTests = withoutOutsideUsers(new Set([...reached].filter((path) => !rooted.has(path))));
  const carries = evidenceReader(tests, evidence);
  const support = withoutOutsideUsers(
    new Set([...onlyTests].filter((path) => carries(onlyTests, path))),
  );
  return { support, testUsed: new Set([...onlyTests].filter((path) => !support.has(path))) };
}

/** The references with every one a test-support file makes counted as a test reference. */
export function supportReferences(
  references: readonly Reference[],
  support: ReadonlySet<string>,
): readonly Reference[] {
  if (support.size === 0) {
    return references;
  }
  return references.map((reference) =>
    !reference.test && support.has(reference.position.path)
      ? { ...reference, test: true }
      : reference,
  );
}
