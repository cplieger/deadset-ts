import { rmSync } from "node:fs";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import { runAnalysis } from "./analysis.ts";
import type { Cascade } from "./config.ts";
import { resolve } from "./resolve.ts";
import { scopeForDir } from "./scope.ts";
import { openEngine, type Engine } from "./session.ts";

/**
 * A library whose findings depend on every kind of answer the analysis asks for:
 * renamed, star and default re-exports from its published module, a renamed and a
 * namespace import, a member read through a property access, a type parameter, a
 * destructured quoted key, a dependency named only by its declaration path, a deprecated
 * declaration, a dead function that calls itself, a test of nothing but dead code, and
 * an interface whose members fall with it.
 */
const LIBRARY: Readonly<Record<string, string>> = {
  "package.json": `${JSON.stringify({
    name: "@example/partial",
    private: true,
    version: "1.0.0",
    type: "module",
    exports: { ".": "./src/index.ts" },
    dependencies: { "left-pad": "1.0.0" },
    devDependencies: { "@types/foo": "1.0.0" },
  })}\n`,
  "tsconfig.json": `${JSON.stringify({
    compilerOptions: {
      strict: true,
      target: "ESNext",
      lib: ["ESNext"],
      types: [],
      module: "NodeNext",
      moduleResolution: "nodenext",
      noEmit: true,
      allowImportingTsExtensions: true,
    },
    include: ["src/**/*.ts"],
  })}\n`,
  "node_modules/left-pad/package.json":
    '{ "name": "left-pad", "version": "1.0.0", "type": "module", "types": "index.d.ts" }\n',
  "node_modules/left-pad/index.d.ts": "export default function pad(text: string): string;\n",
  "node_modules/@types/foo/package.json":
    '{ "name": "@types/foo", "version": "1.0.0", "type": "module", "types": "index.d.ts" }\n',
  "node_modules/@types/foo/index.d.ts": "export declare const foo: number;\n",
  "src/index.ts": [
    'export { original as renamed } from "./relay.ts";',
    'export * from "./starred.ts";',
    'export { default as run } from "./main.ts";',
    "",
  ].join("\n"),
  "src/internal.test.ts": [
    'import { recurse } from "./internal.ts";',
    "",
    "export const checksRecurse = recurse(1);",
    "",
  ].join("\n"),
  "src/relay.ts": "export function original(): number {\n  return 1;\n}\n",
  "src/starred.ts": "export const starred = 2;\nexport const doubled = starred * 2;\n",
  "src/space.ts": "export const inner = 8;\nexport const outer = 9;\n",
  "src/main.ts": [
    'import pad from "left-pad";',
    'import { foo } from "foo";',
    'import { counted as tally, Counter, identity, read, type Invocation } from "./internal.ts";',
    'import * as space from "./space.ts";',
    "",
    "export default function main(invocation: Invocation): string {",
    "  const counter = new Counter();",
    "  return pad(String(tally() + counter.used() + identity(foo) + space.inner + read(invocation)));",
    "}",
    "",
  ].join("\n"),
  "src/internal.ts": [
    "export function counted(): number {",
    "  return 3;",
    "}",
    "",
    "export class Counter {",
    "  used(): number {",
    "    return 4;",
    "  }",
    "",
    "  unused(): number {",
    "    return 5;",
    "  }",
    "}",
    "",
    "export function identity<T>(value: T): T {",
    "  return value;",
    "}",
    "",
    "export interface Invocation {",
    '  readonly "quoted-key": number;',
    "  readonly other: number;",
    "}",
    "",
    "export function read(invocation: Invocation): number {",
    '  const { "quoted-key": quoted } = invocation;',
    "  return quoted;",
    "}",
    "",
    "export function deadExported(): number {",
    "  return 6;",
    "}",
    "",
    "function deadLocal(): number {",
    "  return 7;",
    "}",
    "",
    "/** @deprecated Replaced by counted. */",
    "export function retired(): number {",
    "  return deadLocal();",
    "}",
    "",
    "export function recurse(depth: number): number {",
    "  return depth <= 0 ? 0 : recurse(depth - 1);",
    "}",
    "",
    "export interface Shape {",
    "  readonly size: number;",
    "  readonly unit?: string;",
    "}",
    "",
  ].join("\n"),
};

/** One reported finding: its subject's reference, where it is written, its code and severity. */
interface Reported {
  readonly ref: string;
  readonly at: string;
  readonly code: string;
  readonly severity: string;
}

/** The text the compiler server answers a question with when the question panicked. */
const PANIC = "panic: interface conversion: checker.TypeData is *checker.TypeReference";

let root = "";
let client: Engine | undefined;

beforeAll(() => {
  root = writeProject(LIBRARY);
  client = openEngine({ collectTiming: false });
});

afterAll(() => {
  client?.close();
  rmSync(root, { recursive: true, force: true });
});

/** Whether one question fails, by its accessor and the locations it asks about. */
type Fails = (accessor: string, locations: readonly string[]) => boolean;

/**
 * The library analyzed under one cascade, with every question for which `fails` answers
 * true failing as a server panic. Every accessor and location asked is recorded in `asked`.
 */
function analyzed(cascade: Cascade, fails: Fails, asked?: Set<string>): readonly Reported[] {
  if (client === undefined) {
    throw new Error("the client is opened before any case runs");
  }
  const real = client;
  // A run closes the client it is handed, so it is handed one whose close is left to
  // this file, and whose questions fail where the case says.
  const engine: Engine = {
    ...real,
    close: () => undefined,
    ask: (accessor, locations, question) => {
      const at = locations();
      for (const location of at) {
        asked?.add(`${accessor}\u0000${location}`);
      }
      if (fails(accessor, at)) {
        throw new Error(PANIC);
      }
      return real.ask(accessor, locations, question);
    },
  };
  const host = nodeHost();
  const { config, provenance } = resolve({
    repository: JSON.stringify({ target: { kind: "library" }, reporters: { cascade } }),
    repositoryLabel: "deadset.json",
  });
  const { result } = runAnalysis(engine, host, scopeForDir(host, root), config, provenance, {
    production: true,
  });
  return result.findings.map((finding) => ({
    ref: finding.symbol.ref,
    at: `${finding.position.path}:${String(finding.position.line)}`,
    code: finding.code,
    severity: finding.severity,
  }));
}

/** The references of every container of one declaration's reference, innermost first. */
function containers(ref: string): readonly string[] {
  const [module, chain] = ref.split("#");
  const parts = (chain ?? "").split(".");
  return parts
    .slice(1)
    .map((_, at) => `${module ?? ""}#${parts.slice(0, parts.length - at - 1).join(".")}`);
}

/**
 * What a run with failed questions reports that the answered run does not, or reports
 * under another code or severity. A member is admitted where the answered run reports a
 * container of it dead and the failed run holds that container live: the member is dead
 * in both runs, and the answered run reports it through the container.
 */
function beyond(answered: readonly Reported[], partial: readonly Reported[]): readonly string[] {
  const byPlace = new Map(answered.map((one) => [`${one.ref} ${one.at}`, one]));
  const answeredRefs = new Set(answered.map((one) => one.ref));
  const partialRefs = new Set(partial.map((one) => one.ref));
  return partial.flatMap((one) => {
    const known = byPlace.get(`${one.ref} ${one.at}`);
    if (known !== undefined) {
      return known.code === one.code && known.severity === one.severity
        ? []
        : [`${one.ref}: ${known.code} ${known.severity} became ${one.code} ${one.severity}`];
    }
    const fell = containers(one.ref).some(
      (container) => answeredRefs.has(container) && !partialRefs.has(container),
    );
    return fell ? [] : [`${one.ref}: ${one.code} is reported only where a question failed`];
  });
}

/** A string hash, so a property's draw picks the same questions on every run. */
function hashOf(text: string): number {
  let hash = 2166136261;
  for (let at = 0; at < text.length; at += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(at), 16777619) >>> 0;
  }
  return hash;
}

const ANSWERED: Fails = () => false;

describe("a question the checker does not answer", () => {
  const asked = new Set<string>();
  let full: readonly Reported[] = [];
  let roots: readonly Reported[] = [];

  beforeAll(() => {
    full = analyzed("full", ANSWERED, asked);
    roots = analyzed("roots", ANSWERED);
  });

  it("leaves the answered library reporting what it reports", () => {
    expect(full.map((one) => `${one.code} ${one.ref}`)).toEqual([
      "DS1005 ts://@example/partial/src/internal.test.ts#checksRecurse",
      "DS1003 ts://@example/partial/src/internal.ts#Counter.unused",
      "DS1003 ts://@example/partial/src/internal.ts#Invocation.other",
      "DS1103 ts://@example/partial/src/internal.ts#deadExported",
      "DS1002 ts://@example/partial/src/internal.ts#deadLocal",
      "DS1006 ts://@example/partial/src/internal.ts#retired",
      "DS1103 ts://@example/partial/src/internal.ts#recurse",
      "DS1201 ts://@example/partial/src/internal.ts#Shape",
      "DS1103 ts://@example/partial/src/space.ts#outer",
    ]);
  });

  it("reports nothing a failure could change when every question fails", () => {
    expect(asked.size).toBeGreaterThan(0);
    expect(analyzed("full", () => true).map((one) => `${one.code} ${one.ref}`)).toEqual([]);
  });

  it("withholds findings and never adds or recodes one, for every question failing alone", () => {
    const failures = [...asked].sort().flatMap((question) => {
      const [accessor, location] = question.split("\u0000");
      const fails: Fails = (one, at) => one === accessor && at.includes(location ?? "");
      return beyond(full, analyzed("full", fails)).map((line) => `${question}: ${line}`);
    });
    expect(failures).toEqual([]);
  }, 120_000);

  it("withholds findings and never adds or recodes one, for every accessor failing whole", () => {
    const accessors = [...new Set([...asked].map((question) => question.split("\u0000")[0]))];
    const failures = accessors.sort().flatMap((accessor) =>
      beyond(
        full,
        analyzed("full", (one) => one === accessor),
      ).map((line) => `${accessor ?? ""}: ${line}`),
    );
    expect(failures).toEqual([]);
  }, 60_000);

  /**
   * Property dead-code-suite/P34: for any set of questions the checker fails, the run's
   * findings under the default cascade are the answered run's or fewer, each under the
   * same code and severity, so no component's reported root moves.
   */
  it("withholds findings and never adds or recodes one, for any set of failing questions", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        fc.integer({ min: 1, max: 50 }),
        (salt, rate) => {
          const fails: Fails = (accessor, at) =>
            at.some((location) => hashOf(`${String(salt)} ${accessor} ${location}`) % 100 < rate);
          expect(beyond(roots, analyzed("roots", fails))).toEqual([]);
        },
      ),
      // Every run analyzes the library, so the analysis, not the draw, sets the time.
      { numRuns: 100, interruptAfterTimeLimit: 90_000 },
    );
  }, 120_000);
});
