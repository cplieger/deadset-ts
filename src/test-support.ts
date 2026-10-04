/**
 * Test-support code: a file that is not a test file by name and that only test code
 * imports. At least one test file reaches it, directly or through other such files, and
 * nothing else does, so it is judged with the tests: what it references is referenced by
 * test code, and a declaration of it is live while test code references it.
 */

import type { InventorySymbol } from "./inventory.ts";
import type { Reference } from "./references.ts";
import type { Root } from "./roots.ts";

/** The root kind that never takes a file out of test-support code: the skip only withholds. */
const SKIP_ROOT = "type-error";

/**
 * The files of one project that are test-support code, below the target root. A file
 * holding a root is not one, because a root has a caller outside the import graph: a
 * runtime, a tool, a configuration, or a consumer of a library's published API.
 * `testFiles` are the files the test-file rules classified.
 */
export function testSupportFiles(
  symbols: readonly InventorySymbol[],
  references: readonly Reference[],
  roots: readonly Root[],
  testFiles: readonly string[],
): ReadonlySet<string> {
  const fileOf = new Map(symbols.map((symbol) => [symbol.id, symbol.position.path]));
  const users = new Map<string, Set<string>>();
  for (const reference of references) {
    const used = fileOf.get(reference.to);
    const from = reference.position.path;
    if (reference.consumer !== undefined || used === undefined || used === from) {
      continue;
    }
    const held = users.get(used);
    if (held === undefined) {
      users.set(used, new Set([from]));
    } else {
      held.add(from);
    }
  }
  const tests = new Set(testFiles);
  const rooted = new Set(
    roots.filter((root) => root.kind !== SKIP_ROOT).flatMap((root) => fileOf.get(root.id) ?? []),
  );
  const candidates = [...users.keys()].filter((path) => !tests.has(path) && !rooted.has(path));
  const support = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const path of candidates) {
      if (support.has(path)) {
        continue;
      }
      const from = users.get(path) ?? new Set<string>();
      if ([...from].every((one) => tests.has(one) || support.has(one))) {
        support.add(path);
        changed = true;
      }
    }
  }
  return support;
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
