import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { TSCONFIG, writeProject } from "../__test-helpers__/projects.ts";
import { run, type Writer } from "./run.ts";

class MemoryWriter implements Writer {
  text = "";
  write(text: string): void {
    this.text += text;
  }
}

const RUNS = 12;

/**
 * The findings `run analyze` reports for `files`, as `<code> <name> <relation>`, and what it
 * wrote to stderr.
 */
function analyzedIn(files: Readonly<Record<string, string>>): {
  readonly found: readonly string[];
  readonly err: string;
} {
  const root = writeProject(files);
  const dir = mkdtempSync(join(tmpdir(), "deadset-ts-dynamic-scope-"));
  try {
    const err = new MemoryWriter();
    run(
      ["analyze", `--target=${root}`, `--report=${join(dir, "report.json")}`],
      new MemoryWriter(),
      err,
      {
        ...nodeHost(),
        workingDirectory: () => root,
        analyzerVersion: () => "0.0.0",
      },
    );
    const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8")) as {
      readonly findings: readonly {
        readonly code: string;
        readonly symbol: { readonly name: string };
        readonly liveness_relation?: string;
      }[];
    };
    return {
      found: report.findings
        .filter((one) => one.code !== "DS1602")
        .map((one) => `${one.code} ${one.symbol.name} ${one.liveness_relation ?? "-"}`),
      err: err.text,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The findings of `found` that report `name` unused, and under which relation. */
function deadAs(found: readonly string[], name: string): readonly string[] {
  return found.flatMap((line) => {
    const [code, symbol, relation] = line.split(" ");
    return /^DS100[135]$/u.test(code ?? "") && symbol === name ? [relation ?? ""] : [];
  });
}

/** One function wrapping the next, the last returning `expression`: `g0` is the outermost. */
const LEVELS = ["arrow", "function"] as const;
type Level = (typeof LEVELS)[number];

/** The statements defining `g0` around `expression`, and calling it where `called`. */
function nested(
  expression: string,
  levels: readonly Level[],
  called: boolean,
  take: string,
): string {
  let inner = "";
  let result = expression;
  for (let at = levels.length - 1; at >= 0; at -= 1) {
    const body = `${inner}return ${result};`;
    inner =
      levels[at] === "arrow"
        ? `const g${String(at)} = (): unknown => { ${body} }; `
        : `function g${String(at)}(): unknown { ${body} } `;
    result = `g${String(at)}()`;
  }
  return called ? `${inner}${take}(g0());` : inner;
}

/**
 * How a TypeScript case binds its namespace object `m` (references-ts.4): a namespace import, a
 * `then` arrow callback's parameter, an awaited import's `const`, or a function's `const` of a
 * namespace import, each precisely, or a `then` function callback's parameter, a holder.
 */
const FORMS = ["import", "then-arrow", "then-function", "await", "const"] as const;
/** The forms whose binding, or the namespace import it is given, every code of the file sees. */
const FILE_WIDE: ReadonlySet<(typeof FORMS)[number]> = new Set(["import", "const"]);
/**
 * How the call names `eval`: directly (bare, in parentheses, under a type assertion), indirectly
 * (a comma expression, an optional call), or a call of a local function.
 */
const CALLS = ["bare", "paren", "assert", "comma", "optional", "none"] as const;
const DIRECT: ReadonlySet<(typeof CALLS)[number]> = new Set(["bare", "paren", "assert"]);
const CALLEE: Readonly<Record<(typeof CALLS)[number], string>> = {
  bare: "eval",
  paren: "(eval)",
  assert: "(eval as typeof eval)",
  comma: "(0, eval)",
  optional: "eval?.",
  none: "String",
};

interface Drawn {
  readonly form: (typeof FORMS)[number];
  readonly call: (typeof CALLS)[number];
  readonly levels: readonly Level[];
  /** Whether the call sits in the binding's own scope, or in a function of the file beside it. */
  readonly inside: boolean;
  /** Whether anything calls the functions holding the call, so reachability enters them. */
  readonly called: boolean;
  /**
   * Whether the module imported is a CommonJS `.cts` file, whose `import()` value the checker types
   * as an interop object rather than the namespace object.
   */
  readonly commonjs: boolean;
}

const drawn: fc.Arbitrary<Drawn> = fc.record({
  form: fc.constantFrom(...FORMS),
  call: fc.constantFrom(...CALLS),
  levels: fc.array(fc.constantFrom(...LEVELS), { minLength: 1, maxLength: 3 }),
  inside: fc.boolean(),
  called: fc.boolean(),
  commonjs: fc.boolean(),
});

/** The file name of the module case `at` imports. */
function libFile(one: Drawn, at: number): string {
  return `src/l${String(at)}.${one.commonjs ? "cts" : "ts"}`;
}

/** The file of case `at`, which reads `show<at>` by name and calls `eval` as drawn. */
function caseFile(one: Drawn, at: number): string {
  const n = String(at);
  const call = nested(`${CALLEE[one.call]}("m")`, one.levels, one.called, "take");
  const inside = one.inside ? call : "";
  const beside = one.inside ? "" : `export function beside(): void { ${call} }\nbeside();\n`;
  const take = "function take(value: unknown): void {\n  console.log(value);\n}\n";
  const lib = `"./l${n}.${one.commonjs ? "cjs" : "js"}"`;
  const body: Record<(typeof FORMS)[number], string> = {
    import: `import * as m from ${lib};\nm.show${n}();\n${inside}\n`,
    "then-arrow": `void import(${lib}).then((m) => { m.show${n}(); ${inside} });\n`,
    "then-function": `void import(${lib}).then(function (m) { m.show${n}(); ${inside} });\n`,
    await: `export async function go(): Promise<void> { const m = await import(${lib}); m.show${n}(); ${inside} }\nvoid go();\n`,
    const: `import * as ns from ${lib};\nexport function go(): void { const m = ns; m.show${n}(); ${inside} }\ngo();\n`,
  };
  return `${take}${body[one.form]}${beside}`;
}

/**
 * What the oracle allows for `spare<at>`: live where a function callback holds the value, else
 * whether a drawn eval can read it, and under which relations.
 */
function expected(one: Drawn): "live" | "reference-counting-live" | "precise" {
  if (one.form === "then-function") {
    return "live";
  }
  const sees = DIRECT.has(one.call) && (one.inside || FILE_WIDE.has(one.form));
  return !sees ? "precise" : one.called ? "live" : "reference-counting-live";
}

/** What a JavaScript case's file is: a CommonJS `.cjs` or `.js` script, or an ES module named `.mjs`. */
const SCRIPT_KINDS = ["cjs", "js", "mjs"] as const;
/** What a JavaScript case puts its import to: a `then` arrow or function callback, an awaited `const`, a whole read. */
const SCRIPT_FORMS = ["then-arrow", "then-function", "await", "whole"] as const;
/**
 * How the binding's function reaches `m` by a name: a `with` body naming it or another, an eval,
 * an `arguments` read, or nothing.
 */
const SCRIPT_SITES = ["with-names", "with-other", "eval", "arguments", "none"] as const;

interface DrawnScript {
  readonly kind: (typeof SCRIPT_KINDS)[number];
  readonly form: (typeof SCRIPT_FORMS)[number];
  readonly site: (typeof SCRIPT_SITES)[number];
  /** Whether the import's statement sits inside a `with` body. */
  readonly wrapped: boolean;
  /** Whether a function of the file beside the binding holds a `with` statement. */
  readonly beside: boolean;
  /** Whether the file reads a function's `arguments` property, as a reflecting library does. */
  readonly reflects: boolean;
  readonly levels: readonly Level[];
  readonly called: boolean;
}

/**
 * A `with` statement is a syntax error in a module (ECMA-262 14.11.1), whose statement the analysis
 * then does not evaluate, so none is drawn in an `.mjs` file.
 */
const drawnScript: fc.Arbitrary<DrawnScript> = fc
  .record({
    kind: fc.constantFrom(...SCRIPT_KINDS),
    form: fc.constantFrom(...SCRIPT_FORMS),
    site: fc.constantFrom(...SCRIPT_SITES),
    wrapped: fc.boolean(),
    beside: fc.boolean(),
    reflects: fc.boolean(),
    levels: fc.array(fc.constantFrom(...LEVELS), { minLength: 1, maxLength: 3 }),
    called: fc.boolean(),
  })
  .filter(
    (one) => one.kind !== "mjs" || (!one.site.startsWith("with") && !one.wrapped && !one.beside),
  );

/** A CommonJS script's case with no site, no `with` statement and no reflection. */
const PLAIN_SCRIPT: DrawnScript = {
  kind: "cjs",
  form: "then-arrow",
  site: "none",
  wrapped: false,
  beside: false,
  reflects: false,
  levels: ["arrow"],
  called: false,
};

/** Whether a script case's file holds a `with` statement. */
function holdsWith(one: DrawnScript): boolean {
  return one.site.startsWith("with") || one.wrapped || one.beside;
}

/** The file of script case `at`, with its site nested in functions as drawn. */
function scriptCase(one: DrawnScript, at: number): string {
  const n = String(at);
  let inner = "";
  let result =
    one.site === "with-names"
      ? "WITH(m)"
      : one.site === "with-other"
        ? "WITH(o)"
        : one.site === "eval"
          ? 'eval("m")'
          : one.site === "arguments"
            ? "arguments.length"
            : "o";
  for (let index = one.levels.length - 1; index >= 0; index -= 1) {
    const body = result.startsWith("WITH(")
      ? `${inner}with (o) { return ${result.slice(5, -1)}; }`
      : `${inner}return ${result};`;
    const name = `g${String(index)}`;
    inner =
      one.levels[index] === "arrow"
        ? `const ${name} = () => { ${body} }; `
        : `function ${name}() { ${body} } `;
    result = `${name}()`;
  }
  const site = one.called ? `${inner}console.log(g0());` : inner;
  const lib = `"./l${n}.mjs"`;
  const statement = {
    "then-arrow": `import(${lib}).then((m) => { m.show${n}(); ${site} });`,
    "then-function": `import(${lib}).then(function (m) { m.show${n}(); ${site} });`,
    await: `async function go() { const m = await import(${lib}); m.show${n}(); ${site} }\ngo();`,
    whole: `import(${lib}).then(console.log);`,
  }[one.form];
  const placed = one.wrapped ? `with (o) {\n${statement}\n}` : statement;
  const beside = one.beside ? "function beside(p) { with (p) { return 1; } }\nbeside({});\n" : "";
  const reflects = one.reflects
    ? "function peek(f) { return f.arguments; }\nconsole.log(peek(peek));\n"
    : "";
  return `var o = {};\n${beside}${reflects}${placed}\n`;
}

/** The file name of script case `at`. */
function scriptFile(one: DrawnScript, at: number): string {
  return `src/c${String(at)}.${one.kind}`;
}

/**
 * What the oracle allows for `spare<at>` of a script case among `draws`: live at a whole read, for
 * a function callback, which holds the value, in a file holding a `with` statement, and wherever
 * any import sits in a `with` body (an unanswered module, program.33); live where called for
 * another binding's direct eval; precise otherwise, a CommonJS script's as a module's, beside
 * an `arguments` site or a program reading a function's `arguments` too.
 */
function expectedScript(
  one: DrawnScript,
  draws: readonly DrawnScript[],
): "live" | "reference-counting-live" | "precise" {
  if (
    one.form === "whole" ||
    one.form === "then-function" ||
    holdsWith(one) ||
    draws.some((other) => other.wrapped)
  ) {
    return "live";
  }
  return one.site !== "eval" ? "precise" : one.called ? "live" : "reference-counting-live";
}

describe("a direct eval that can see a namespace binding, and a with statement in JavaScript", () => {
  // Property: a direct eval, bare, in parentheses or under an erased assertion, at any depth of
  // nested functions inside a namespace binding's scope, reads the binding whole (references-ts.4):
  // no export is reported unused under reference counting, nor under reachability where the eval's
  // functions are called. An indirect eval, a local call, or an eval out of the binding's scope
  // leaves it precise, so the unread export is reported, a CommonJS module's as an ES module's. A
  // function callback binds nothing, so its import reads every export.
  it("reads whole every namespace binding a drawn direct eval can see, under both relations", () => {
    fc.assert(
      fc.property(fc.array(drawn, { minLength: 1, maxLength: 5 }), (draws) => {
        const files: Record<string, string> = {
          "deadset.json": JSON.stringify({
            target: { kind: "application" },
            analysis: { min_confidence: "possible" },
            ts: { entry_files: ["src/main.ts"] },
          }),
          "package.json": '{ "name": "@example/app", "private": true, "type": "module" }\n',
          "tsconfig.json": JSON.stringify({ ...JSON.parse(TSCONFIG), include: ["**/*"] }),
          "src/main.ts": `${draws.map((_one, at) => `import "./c${String(at)}.js";`).join("\n")}\n`,
        };
        draws.forEach((one, at) => {
          const n = String(at);
          files[libFile(one, at)] =
            `export function show${n}(): void {}\nexport function spare${n}(): void {}\n`;
          files[`src/c${n}.ts`] = caseFile(one, at);
        });
        const { found, err } = analyzedIn(files);
        expect(err, "stderr").toBe("");
        draws.forEach((one, at) => {
          const n = String(at);
          const label = `${JSON.stringify(one)}\n${files[`src/c${n}.ts`] ?? ""}`;
          expect(deadAs(found, `show${n}`), label).toEqual([]);
          const spare = deadAs(found, `spare${n}`);
          const wanted = expected(one);
          if (wanted === "live") {
            expect(spare, label).toEqual([]);
          } else if (wanted === "reference-counting-live") {
            expect(spare, label).not.toContain("reference-counting");
          } else {
            expect(spare, label).toEqual(["reference-counting"]);
          }
        });
      }),
      { numRuns: RUNS, plugins: [fc.interruptAfterTimeLimit(240_000, { failOnInterrupt: true })] },
    );
  }, 300_000);

  // Property: JavaScript binds a namespace object precisely in any file that holds no `with`
  // statement, a CommonJS script's as a module's (references-ts.4): in a file with a `with`
  // statement anywhere, at a whole read and through a function callback, every export is read,
  // under both relations; a direct eval at any depth of nested functions in the binding's scope
  // reads it whole, and no other site, an `arguments` read or a reflecting program's, leaves it
  // anything but precise.
  it("binds a namespace object in every file that holds no with statement, under both relations", () => {
    fc.assert(
      fc.property(fc.array(drawnScript, { minLength: 1, maxLength: 5 }), (draws) => {
        const files: Record<string, string> = {
          "deadset.json": JSON.stringify({
            target: { kind: "application" },
            analysis: { min_confidence: "possible" },
            ts: { entry_files: draws.map((one, at) => scriptFile(one, at)) },
          }),
          "package.json": '{ "name": "@example/app", "private": true }\n',
          "tsconfig.json": JSON.stringify({
            compilerOptions: {
              strict: false,
              allowJs: true,
              checkJs: false,
              target: "ESNext",
              module: "NodeNext",
              moduleResolution: "nodenext",
              noEmit: true,
            },
          }),
        };
        draws.forEach((one, at) => {
          const n = String(at);
          files[`src/l${n}.mjs`] =
            `export function show${n}() {}\nexport function spare${n}() {}\n`;
          files[scriptFile(one, at)] = scriptCase(one, at);
        });
        const { found, err } = analyzedIn(files);
        expect(
          err.split("\n").filter((line) => line !== "" && !line.includes("the checker answered")),
          "stderr",
        ).toEqual([]);
        draws.forEach((one, at) => {
          const n = String(at);
          const label = `${JSON.stringify(one)}\n${scriptCase(one, at)}`;
          expect(deadAs(found, `show${n}`), label).toEqual([]);
          const spare = deadAs(found, `spare${n}`);
          const wanted = expectedScript(one, draws);
          if (wanted === "live") {
            expect(spare, label).toEqual([]);
          } else if (wanted === "reference-counting-live") {
            expect(spare, label).not.toContain("reference-counting");
          } else {
            expect(spare, label).toEqual(["reference-counting"]);
          }
        });
      }),
      {
        numRuns: RUNS,
        // A function callback in a reflecting program and in a plain one, each beside an arrow.
        examples: [
          [
            [
              { ...PLAIN_SCRIPT, form: "then-function", reflects: true },
              { ...PLAIN_SCRIPT, form: "then-arrow", reflects: true },
              { ...PLAIN_SCRIPT, kind: "js", form: "then-function" },
            ],
          ],
        ],
        plugins: [fc.interruptAfterTimeLimit(240_000, { failOnInterrupt: true })],
      },
    );
  }, 300_000);
});
