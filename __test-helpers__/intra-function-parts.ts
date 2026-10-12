import { rmSync } from "node:fs";
import { emitterInputOf, findingsOf } from "./emitter-input.ts";
import { TSCONFIG, writeProject } from "./projects.ts";
import { resolve } from "../src/resolve.ts";
import type { Engine } from "../src/session.ts";

/** The bound on one case, each of which loads a whole target. */
export const LOAD_TIMEOUT = 60_000;

/** What one application is written and swept with beside its entry file. */
export interface PartsOptions {
  /** More files, by path below the root; a `tsconfig*.json` entry adds or replaces a project. */
  readonly files?: Readonly<Record<string, string>>;
  /** More top-level keys of `deadset.json`. */
  readonly repository?: Readonly<Record<string, unknown>>;
  readonly engine?: Engine;
}

/** The default compiler configuration with more compiler options. */
export function tsconfigWith(options: Readonly<Record<string, unknown>>): string {
  const base = JSON.parse(TSCONFIG) as { compilerOptions: Record<string, unknown> };
  return `${JSON.stringify({ ...base, compilerOptions: { ...base.compilerOptions, ...options } })}\n`;
}

/**
 * The intra-function findings of one application whose entry file is `src/main.ts`, as
 * `<code> <name> <path>:<line>` in position order, the application removed afterwards.
 * The default compiler configuration sets none of `noUnusedParameters`, `noUnusedLocals`
 * and `allowUnreachableCode`.
 */
export function partsOf(main: readonly string[], options: PartsOptions = {}): string[] {
  const root = writeProject({
    "package.json": '{ "name": "@example/parts", "private": true, "type": "module" }\n',
    "src/main.ts": `${main.join("\n")}\n`,
    ...options.files,
  });
  try {
    const { config } = resolve({
      repository: JSON.stringify({
        target: { kind: "application" },
        ts: { entry_files: ["src/main.ts"] },
        ...options.repository,
      }),
      repositoryLabel: "deadset.json",
    });
    return findingsOf(
      emitterInputOf(root, config, options.engine === undefined ? {} : { engine: options.engine }),
    )
      .filter((finding) => finding.code.startsWith("DS18"))
      .toSorted(
        (a, b) =>
          a.position.path.localeCompare(b.position.path) ||
          a.position.line - b.position.line ||
          a.code.localeCompare(b.code) ||
          a.symbol.name.localeCompare(b.symbol.name),
      )
      .map(
        (finding) =>
          `${finding.code} ${finding.symbol.name} ${finding.position.path}:${String(finding.position.line)}`,
      );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
