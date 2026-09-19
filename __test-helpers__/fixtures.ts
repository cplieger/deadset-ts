import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Helpers over the committed fixtures. They live outside `src/` because a module
 * under `src/` that the exported surface does not reach is published and
 * unreachable, which the publish-surface check reports; `tsconfig.test.json` is
 * what type-checks this directory.
 */

/** The repository root. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** One path below the fixtures directory. */
export function fixture(...parts: readonly string[]): string {
  return join(ROOT, "fixtures", ...parts);
}

/** The text of one committed fixture. */
export function readFixture(...parts: readonly string[]): string {
  return readFileSync(fixture(...parts), "utf8");
}

/** One document of the committed copy of the Contract, decoded. */
export function contractDocument(name: string): Record<string, unknown> {
  return JSON.parse(readFixture("contract", name)) as Record<string, unknown>;
}

/** The pin naming the Contract release the committed copy came from. */
export function corpusLock(): {
  tag: string;
  commit: string;
  contract_version: string;
  digests: Record<string, string>;
} {
  return JSON.parse(readFileSync(join(ROOT, "corpus.lock.json"), "utf8")) as ReturnType<
    typeof corpusLock
  >;
}

/** The published configuration vector cases, in ascending order. */
export function configVectorCases(): string[] {
  return readdirSync(fixture("vectors", "config"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** The text of one file of one vector case, or undefined when the case has none. */
export function vectorFile(name: string, file: string): string | undefined {
  try {
    return readFixture("vectors", "config", name, file);
  } catch {
    return undefined;
  }
}

/** Every file below one directory, as paths relative to it, in ascending order. */
function filesUnder(dir: string): string[] {
  const found: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      found.push(relative(dir, path).split("\\").join("/"));
    }
  };
  walk(dir);
  return found.sort();
}

/**
 * The digest `corpus.lock.json` records for one committed tree: sha256 over, for
 * each file in ascending path order, the path, a newline, the file's sha256 in
 * lowercase hexadecimal and a newline.
 */
export function digestOf(dir: string): string {
  const hash = createHash("sha256");
  for (const path of filesUnder(dir)) {
    const content = createHash("sha256")
      .update(readFileSync(join(dir, path)))
      .digest("hex");
    hash.update(`${path}\n${content}\n`);
  }
  return hash.digest("hex");
}
