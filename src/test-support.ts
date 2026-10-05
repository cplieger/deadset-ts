/**
 * Test-support code: the files only tests reach. A test reaches each one through a chain
 * of references, and every reference to a declaration of one, an import for its effects
 * included, is written in a test file or in another such file, so it is judged with the
 * tests: what it references is referenced by test code.
 */

import type { InventorySymbol } from "./inventory.ts";
import type { Reference } from "./references.ts";
import type { Root } from "./roots.ts";

/** The root kind that never takes a file out of test-support code: the skip only withholds. */
const SKIP_ROOT = "type-error";

/**
 * The files of one project that are test-support code, below the target root: the
 * largest set of files a test file reaches, none of them a test file or holding a root,
 * whose every user outside the set is a test file. A root has a caller outside the
 * reference graph: a runtime, a tool, a configuration, or a consumer of a library's
 * published API. `testFiles` are the files the test-file rules classified.
 */
export function testSupportFiles(
  symbols: readonly InventorySymbol[],
  references: readonly Reference[],
  roots: readonly Root[],
  testFiles: readonly string[],
): ReadonlySet<string> {
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
  const support = new Set([...reached].filter((path) => !rooted.has(path)));
  for (let changed = true; changed;) {
    changed = false;
    for (const path of support) {
      const from = users.get(path) ?? new Set<string>();
      if (![...from].every((one) => tests.has(one) || support.has(one))) {
        support.delete(path);
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
