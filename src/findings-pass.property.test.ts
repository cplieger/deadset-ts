import { rmSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import { runAnalysis } from "./analysis.ts";
import type { PassResult } from "./findings-pass.ts";
import { resolve } from "./resolve.ts";
import { scopeForDir } from "./scope.ts";
import { openEngine, type Engine } from "./session.ts";
import type { Mechanism } from "./suppress.ts";
import { BASELINE_FILE, IGNORE_FILE, writeBaseline } from "./suppress-file.ts";

/**
 * One iteration writes a project and runs the pass over it twice, each run sweeping the
 * project with and without its marks in a fresh snapshot of one shared client.
 */
const RUNS = 12;

/** The compiler configuration a drawn project carries. */
const TSCONFIG = JSON.stringify({
  compilerOptions: {
    strict: true,
    target: "ESNext",
    lib: ["ES2023"],
    types: [],
    module: "NodeNext",
    moduleResolution: "nodenext",
    noEmit: true,
  },
  include: ["**/*.ts"],
});

const PACKAGE = "@example/drawn";

/**
 * One drawn call graph over the functions `f0` to `f<n-1>` of one file, none of them
 * exported: the entry calls `used`, `used` calls the functions `live` names, and
 * function `i` calls the functions `calls[i]` names.
 */
interface Graph {
  readonly live: readonly number[];
  readonly calls: readonly (readonly number[])[];
}

const graph: fc.Arbitrary<Graph> = fc.integer({ min: 2, max: 6 }).chain((size) => {
  const index = fc.integer({ min: 0, max: size - 1 });
  // Few calls per function, so most draws leave a function dead and a suppression often
  // keeps a dead function's callee live.
  return fc.record({
    live: fc.uniqueArray(index, { maxLength: 1 }),
    calls: fc.array(fc.uniqueArray(index, { maxLength: 2 }), { minLength: size, maxLength: size }),
  });
});

/** The functions reachable from the ones given, those included. */
function closure(from: readonly number[], calls: readonly (readonly number[])[]): Set<number> {
  const seen = new Set<number>();
  const queue = [...from];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    if (!seen.has(next)) {
      seen.add(next);
      queue.push(...(calls[next] ?? []));
    }
  }
  return seen;
}

/** The library file of a graph, an inline directive above every function `marked` names. */
function libraryOf({ live, calls }: Graph, marked: ReadonlySet<number>): string {
  const body = (callees: readonly number[]): string =>
    callees.map((one) => ` f${String(one)}();`).join("");
  return [
    `export function used(): void {${body(live)} }`,
    ...calls.flatMap((callees, at) => [
      ...(marked.has(at)
        ? ["// deadset:ignore DS1002 -- Reached through a drawn adjudication."]
        : []),
      `function f${String(at)}(): void {${body(callees)} }`,
    ]),
    "",
  ].join("\n");
}

/** Each finding of a pass as its code and the name of its subject, in report order. */
function named(result: PassResult): string[] {
  return result.findings.map((finding) => `${finding.code} ${finding.symbol.name}`);
}

/**
 * Property dead-code-suite/P15: for any reported finding set and for each mechanism, writing
 * those findings into the mechanism's document suppresses exactly them on the next run
 * and reports no stale suppression. A suppression marks its declaration live before the
 * sweep, so a function reached only through a suppressed one is no longer reported; the
 * expected findings are the drawn call graph's reachability, computed from the draw.
 */
describe("a suppression document written from a run's findings", () => {
  it.each<Mechanism>(["inline", "ignore", "baseline"])(
    "as %s suppresses exactly those findings and what only they reach, with no stale entry",
    (mechanism) => {
      const { config, provenance } = resolve({
        repository: '{ "target": { "kind": "application" } }',
        repositoryLabel: "deadset.json",
      });
      const host = nodeHost();
      // One client serves every run, each in its own snapshot: a run closes the client it
      // is handed, so the run is handed one whose close is left to this test.
      const client = openEngine({ collectTiming: false });
      const shared: Engine = { ...client, close: () => undefined };
      const passOver = (root: string): PassResult =>
        runAnalysis(shared, host, scopeForDir(host, root), config, provenance, {
          production: true,
        }).result;
      try {
        fc.assert(
          fc.property(
            graph,
            fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }),
            (drawn, chosen) => {
              const reachable = closure(drawn.live, drawn.calls);
              const dead = drawn.calls.map((_calls, at) => at).filter((at) => !reachable.has(at));
              const files = (
                lib: string,
                documents: Readonly<Record<string, string>>,
              ): Record<string, string> => ({
                "tsconfig.json": TSCONFIG,
                "package.json": JSON.stringify({
                  name: PACKAGE,
                  private: true,
                  type: "module",
                  main: "./main.ts",
                }),
                "main.ts": 'import { used } from "./lib.js";\nused();\n',
                "lib.ts": lib,
                ...documents,
              });
              const roots = [writeProject(files(libraryOf(drawn, new Set()), {}))];
              try {
                const before = passOver(roots[0] ?? "");
                expect(named(before)).toEqual(dead.map((at) => `DS1002 f${String(at)}`));

                const written = before.findings.filter((_finding, at) => chosen[at] === true);
                const suppressed = written.map((finding) => Number(finding.symbol.name.slice(1)));
                const entries = written.map((finding) => ({
                  code: finding.code,
                  symbol: finding.symbol.ref,
                  path: finding.position.path,
                }));
                const reason = "Reached through a drawn adjudication.";
                // The next run reads a second tree: a snapshot reads a file once per client,
                // so a file rewritten in place would be read as it was.
                const next = {
                  inline: () => files(libraryOf(drawn, new Set(suppressed)), {}),
                  ignore: () =>
                    files(libraryOf(drawn, new Set()), {
                      [IGNORE_FILE]: JSON.stringify({
                        ignore: entries.map((entry) => ({ ...entry, reason })),
                      }),
                    }),
                  baseline: () =>
                    files(libraryOf(drawn, new Set()), {
                      [BASELINE_FILE]: writeBaseline(entries, {
                        analyzer: "deadset-ts",
                        version: "1.0.0",
                      }),
                    }),
                }[mechanism];
                roots.push(writeProject(next()));
                const after = passOver(roots[1] ?? "");
                const kept = closure(suppressed, drawn.calls);
                expect(named(after)).toEqual(
                  dead.filter((at) => !kept.has(at)).map((at) => `DS1002 f${String(at)}`),
                );
                expect(after.staleSuppressions).toEqual([]);
                expect(after.totals.suppressionsInEffect).toBe(suppressed.length);
              } finally {
                for (const root of roots) {
                  rmSync(root, { recursive: true, force: true });
                }
              }
            },
          ),
          { numRuns: RUNS },
        );
      } finally {
        client.close();
      }
    },
    60_000,
  );
});
