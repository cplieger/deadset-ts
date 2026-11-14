import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emitterInputOf, findingsOf } from "../__test-helpers__/emitter-input.ts";
import { LOAD_TIMEOUT } from "../__test-helpers__/project-needs.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import { nodeHost } from "../bin/node-host.ts";
import { resolve } from "./resolve.ts";
import { run, type Writer } from "./run.ts";
import { openEngine, type Engine } from "./session.ts";

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    strict: true,
    target: "ESNext",
    lib: ["ESNext", "DOM"],
    module: "ESNext",
    moduleResolution: "bundler",
    noEmit: true,
  },
  include: ["src/**/*.ts"],
});

/**
 * Each finding of an application entered at `src/main.ts`, or of a library publishing it, at the
 * lowest minimum confidence, as `<code> <name> <relation>`. `src/dead.ts` is a file nothing
 * imports, so what only it reads is live under reference counting and dead under reachability.
 * `engine` may be one that fails.
 */
function reported(
  files: Readonly<Record<string, string>>,
  engine?: Engine,
  library = false,
): readonly string[] {
  const root = writeProject({
    "package.json": library
      ? '{ "name": "@example/m", "type": "module", "exports": "./src/main.ts" }\n'
      : '{ "name": "@example/m", "private": true, "type": "module" }\n',
    "tsconfig.json": TSCONFIG,
    ...files,
  });
  try {
    const { config } = resolve({
      repository: {
        text: JSON.stringify(
          library
            ? { target: { kind: "library" }, analysis: { min_confidence: "possible" } }
            : {
                target: { kind: "application" },
                analysis: { min_confidence: "possible" },
                ts: { entry_files: ["src/main.ts"] },
              },
        ),
        label: "deadset.json",
      },
    });
    return findingsOf(emitterInputOf(root, config, engine === undefined ? {} : { engine }))
      .filter((one) => one.code !== "DS1602")
      .map((one) => `${one.code} ${one.symbol.name} ${one.livenessRelation ?? "-"}`)
      .sort();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * The findings `run analyze` reports for an application entered at `src/main.ts`, its suppression
 * directives read, as `<code> <name> <relation>`, but each file's own `DS1602`.
 */
function analyzed(files: Readonly<Record<string, string>>): readonly string[] {
  const root = writeProject({
    "deadset.json": JSON.stringify({
      target: { kind: "application" },
      analysis: { min_confidence: "possible" },
      ts: { entry_files: ["src/main.ts"] },
    }),
    "package.json": '{ "name": "@example/m", "private": true, "type": "module" }\n',
    "tsconfig.json": TSCONFIG,
    ...files,
  });
  const dir = mkdtempSync(join(tmpdir(), "namespace-declarations-"));
  const sink = (): Writer & { text: string } => ({
    text: "",
    write(text: string): void {
      this.text += text;
    },
  });
  try {
    run(["analyze", `--target=${root}`, `--report=${join(dir, "report.json")}`], sink(), sink(), {
      ...nodeHost(),
      workingDirectory: () => root,
      analyzerVersion: () => "0.0.0",
    });
    const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8")) as {
      readonly findings: readonly {
        readonly code: string;
        readonly symbol: { readonly name: string };
        readonly liveness_relation?: string;
      }[];
    };
    return report.findings
      .filter((one) => one.code !== "DS1602")
      .map((one) => `${one.code} ${one.symbol.name} ${one.liveness_relation ?? "-"}`)
      .sort();
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The findings of `found` that report one of `names` unused, under either relation. */
function deadOf(found: readonly string[], names: readonly string[]): readonly string[] {
  return found.filter((line) =>
    names.some((name) => /^DS100[135] /.test(line) && line.split(" ")[1] === name),
  );
}

/**
 * The findings of `files` where the checker throws at the name `before` starts in `path`, at its
 * first place, so the use there is one the checker leaves unanswered.
 */
function reportedFailing(
  files: Readonly<Record<string, string>>,
  path: string,
  before: string,
): readonly string[] {
  const place = `/${path}:${String(files[path]?.indexOf(before) ?? -1)}`;
  const opened = openEngine({ collectTiming: false });
  return reported(files, {
    ...opened,
    ask: (accessor, locations, question) => {
      if (accessor === "getSymbolAtLocation" && locations().some((one) => one.endsWith(place))) {
        throw new Error(`panic: ${accessor}`);
      }
      return opened.ask(accessor, locations, question);
    },
  });
}

const LIB = "export function kept(): void {}\nexport function onlyDead(): void {}\n";
const DEAD = 'import { onlyDead } from "./lib.js";\nonlyDead();\n';
const OTHER = "export function otherDead(): void {}\n";
const DEAD_BOTH = `${DEAD}import { otherDead } from "./other.js";\notherDead();\n`;
/** A namespace holding `lib` beside two functions; `dead.ts` calls `N.g` and `onlyDead`. */
const FN =
  'import * as lib from "./lib.js";\nexport namespace N {\n  export const space = lib;\n' +
  "  export function f(): number { return 1; }\n  export function g(): number { return 2; }\n}\n";
const DEAD_G = `import { N } from "./ns.js";\nexport function deadN(): number { return N.g(); }\n${DEAD}`;

/** The findings of one entry reading `FN`'s namespace. */
function readingN(main: string, extra: Readonly<Record<string, string>> = {}): readonly string[] {
  return reported({
    "src/lib.ts": LIB,
    "src/ns.ts": FN,
    "src/main.ts": `import { N } from "./ns.js";\n${main}`,
    "src/dead.ts": DEAD_G,
    ...extra,
  });
}

describe("a whole read of a namespace declaration", () => {
  it(
    "reaches no member of a `declare module` an import names but the members it imports, whatever its name spells (references-ts.4, .7)",
    () => {
      const shim = (name: string): string =>
        `declare module "${name}" {\n  export const used: string;\n  export const title: string;\n}\n`;
      for (const [name, rendered] of [
        ["config", "config"],
        ["foo-bar", "'foo-bar'"],
      ] as const) {
        const found = reported({
          "src/shims.d.ts": shim(name),
          "src/main.ts": `import { used } from "${name}";\nconsole.log(used);\n`,
          "src/dead.ts": `import { title } from "${name}";\nconsole.log(title);\n`,
        });
        expect(found, name).toContain(`DS1001 ${rendered}.title reachability`);
      }
    },
    LOAD_TIMEOUT * 2,
  );

  it(
    "uses the holders a namespace exports, inside a module block or named `global` (references-ts.5)",
    () => {
      const held = (name: string): string =>
        `import * as lib from "./lib.js";\nnamespace ${name} {\n  export const space = lib;\n}\nconsole.log(${name});\n`;
      for (const name of ["Holder", "global"]) {
        expect(
          reported({ "src/lib.ts": LIB, "src/main.ts": held(name), "src/dead.ts": DEAD }),
          name,
        ).not.toContain("DS1001 onlyDead reachability");
      }
      // `Inner` is a namespace inside a module block: a whole read of it uses its holder.
      const blocked = reported({
        "src/shims.d.ts":
          'declare module "lib-pkg" {\n  export const kept: string;\n  export const onlyDead: string;\n}\n' +
          'declare module "x-y" {\n  import * as lib from "lib-pkg";\n  export namespace Inner {\n    export import space = lib;\n  }\n}\n',
        "src/main.ts": 'import { Inner } from "x-y";\nconsole.log(Inner);\n',
        "src/dead.ts": 'import { onlyDead } from "lib-pkg";\nconsole.log(onlyDead);\n',
      });
      expect(blocked).not.toContain("DS1001 'lib-pkg'.onlyDead reachability");
    },
    LOAD_TIMEOUT * 3,
  );

  it(
    "reads every member a namespace exports through a whole read, a holder, and a call or `new` of a merged function or class (references-ts.5)",
    () => {
      const N =
        "export namespace N {\n  export function f(): number { return 1; }\n  export function g(): number { return 2; }\n}\n";
      const DEAD_N =
        'import { N } from "./lib.js";\nexport function deadN(): number { return N.g(); }\n';
      for (const [label, lib, main, dead, member] of [
        ["whole", N, 'import { N } from "./lib.js";\nconsole.log(N);\n', DEAD_N, "N.g"],
        [
          "a call",
          "export function F(): number { return 1; }\nexport namespace F { export function helper(): number { return 2; } }\n",
          'import { F } from "./lib.js";\nconsole.log(F());\n',
          'import { F } from "./lib.js";\nexport function deadFn(): number { return F.helper(); }\n',
          "F.helper",
        ],
        [
          "new",
          "export class C { n = 1; }\nexport namespace C { export function helper(): number { return 2; } }\n",
          'import { C } from "./lib.js";\nconsole.log(new C().n);\n',
          'import { C } from "./lib.js";\nexport function deadFn(): number { return C.helper(); }\n',
          "C.helper",
        ],
      ] as const) {
        const found = reported({ "src/lib.ts": lib, "src/main.ts": main, "src/dead.ts": dead });
        expect(deadOf(found, [member]), label).toEqual([]);
      }
      // A read by name reads the member it names alone, through a `const` binding too (.4).
      for (const main of ["console.log(N.f());\n", "const space = N;\nconsole.log(space.f());\n"]) {
        expect(
          reported({
            "src/lib.ts": N,
            "src/main.ts": `import { N } from "./lib.js";\n${main}`,
            "src/dead.ts": DEAD_N,
          }),
          main,
        ).toContain("DS1001 N.g reachability");
      }
    },
    LOAD_TIMEOUT * 5,
  );
});

describe("a read of a namespace value: three forms read one member, and every other read is whole", () => {
  it(
    "reads only the member a read by name, a literal index or an object pattern of names reads (references-ts.4)",
    () => {
      for (const main of [
        "console.log(N.f());\n",
        'console.log(N["f"]());\n',
        "console.log(N[`f`]());\n",
        "const { f } = N;\nconsole.log(f());\n",
        "const { f: alias } = N;\nconsole.log(alias());\n",
        'const { "f": quoted } = N;\nconsole.log(quoted());\n',
      ]) {
        const found = readingN(main);
        expect(found, main).toContain("DS1001 N.g reachability");
        expect(found, main).toContain("DS1001 onlyDead reachability");
      }
      // The same forms on a module's namespace object.
      for (const main of ["m.f();\n", 'm["f"]();\n', "const { f } = m;\nf();\n"]) {
        const found = reported({
          "src/m.ts": "export function f(): void {}\nexport function g(): void {}\n",
          "src/main.ts": `import * as m from "./m.js";\n${main}`,
          "src/dead.ts": 'import { g } from "./m.js";\ng();\n',
        });
        expect(found, main).toContain("DS1001 g reachability");
      }
    },
    LOAD_TIMEOUT * 9,
  );

  it(
    "reads every member through any other read, whatever type a key has (references-ts.5)",
    () => {
      const names = ["N.g", "onlyDead", "kept"];
      for (const main of [
        'declare const key: "f";\nconsole.log(N[key]());\n',
        'declare const key: "f" | "g";\nconsole.log(N[key]());\n',
        "declare const key: string;\nconsole.log(N[key]);\n",
        'export function call<K extends "f">(k: K): number { return N[k](); }\ncall("f");\n',
        'export function call<K extends string>(k: K): void { (N[k] as () => void)(); }\ncall("f");\n',
        'export function call<K extends PropertyKey>(k: K): void { (N[k] as () => void)(); }\ncall("f");\n',
        'export function call<K extends string | "f">(k: K): void { (N[k] as () => void)(); }\ncall("f");\n',
        'export function get<K extends string>(k: K): unknown { return N[k]; }\nconsole.log(get("space"));\n',
        'const { ["f"]: f } = N;\nconsole.log(f());\n',
        "const { f, ...rest } = N;\nconsole.log(f(), rest);\n",
        "console.log(N);\n",
        "console.log(Object.keys(N));\n",
        "for (const k in N) {\n  console.log(k);\n}\n",
        'console.log("f" in N);\n',
        "console.log({ ...N });\n",
      ]) {
        expect(deadOf(readingN(main), names), main).toEqual([]);
      }
      // A `const` given the namespace binds it, so a read through it by name reads that member (.4).
      for (const main of [
        "const space = N;\nconsole.log(space.f());\n",
        "export function run(): number {\n  const s = N;\n  return s.f();\n}\nrun();\n",
      ]) {
        expect(readingN(main), main).toContain("DS1001 N.g reachability");
      }
      // A holder another file declares passes the namespace on whole.
      const found = readingN('import { held } from "./mid.js";\nconsole.log(held.f());\n', {
        "src/mid.ts": 'import { N } from "./ns.js";\nexport const held = N;\n',
      });
      expect(deadOf(found, names)).toEqual([]);
    },
    LOAD_TIMEOUT * 19,
  );

  it(
    "reads every member a typed key can name, through a binding it initializes too (references-ts.5)",
    () => {
      const HOLDERS =
        'import * as lib from "./lib.js";\nimport * as other from "./other.js";\n' +
        "export const a = lib;\nexport const b = other;\n";
      const NS_HOLDERS =
        'import * as lib from "./lib.js";\nimport * as other from "./other.js";\n' +
        "export namespace N {\n  export const a = lib;\n  export const b = other;\n}\n";
      const names = ["kept", "onlyDead", "otherDead"];
      const holders = (
        main: string,
        extra: Readonly<Record<string, string>> = {},
      ): readonly string[] =>
        reported({
          "src/lib.ts": LIB,
          "src/other.ts": OTHER,
          "src/holders.ts": HOLDERS,
          "src/ns.ts": NS_HOLDERS,
          "src/main.ts": `import * as h from "./holders.js";\nimport { N } from "./ns.js";\n${main}`,
          "src/dead.ts": DEAD_BOTH,
          ...extra,
        });
      for (const main of [
        'declare const key: "a";\nconst v = h[key];\nconsole.log(v);\n',
        'declare const key: "a";\nconst v = h[key];\nv.kept();\n',
        'declare const key: "a";\nexport function run(): void { const v = h[key]; v.kept(); }\nrun();\n',
        'declare const key: "a" | "b";\nconst v = h[key];\nv.kept();\n',
        'declare const key: "a";\nconst v = N[key];\nconsole.log(v);\n',
        'declare const key: "a";\nexport function run(): void { const v = N[key]; v.kept(); }\nrun();\n',
      ]) {
        expect(deadOf(holders(main), names), main).toEqual([]);
      }
      const across = holders('import { v } from "./mid.js";\nconsole.log(v);\n', {
        "src/mid.ts":
          'import * as h from "./holders.js";\ndeclare const key: "a";\nexport const v = h[key];\n',
      });
      expect(deadOf(across, names)).toEqual([]);
      // A literal index reads `a` alone, which holds `lib` whole: `other` is read by no one.
      const literal = holders('const v = h["a"];\nv.kept();\n');
      expect(deadOf(literal, ["kept", "onlyDead"])).toEqual([]);
      expect(literal).toContain("DS1001 otherDead reachability");
    },
    LOAD_TIMEOUT * 9,
  );

  it(
    "reads every member of a class or enum merged with a namespace through a key whose constraint is no literal (references-ts.5, .25)",
    () => {
      const CLS =
        "export class C { static s(): void {} static t(): void {} }\nexport namespace C { export const x = 1; }\n";
      const classFound = reported({
        "src/c.ts": CLS,
        "src/main.ts":
          'import { C } from "./c.js";\nexport function run<K extends string>(k: K): void { (C[k] as () => void)(); }\nrun("s");\n',
      });
      expect(deadOf(classFound, ["C.s", "C.t", "C.x"])).toEqual([]);
      const ENUM =
        "export enum E { A = 1, B = 2 }\nexport namespace E { export function f(): void {} }\n";
      const enumFound = reported({
        "src/e.ts": ENUM,
        "src/main.ts":
          'import { E } from "./e.js";\nexport function get<K extends string>(k: K): unknown { return E[k]; }\nconsole.log(get("A"));\n',
      });
      expect(deadOf(enumFound, ["E.f"])).toEqual([]);
    },
    LOAD_TIMEOUT * 2,
  );

  it(
    "writes the member a store by name or literal index names and nothing else, and reads every member through any other store (references-ts.4, .5)",
    () => {
      const HW =
        'import * as lib from "./lib.js";\nexport namespace N {\n  export const a = lib;\n' +
        "  export let c = 1;\n  export let d = 1;\n" +
        "  export namespace M { export let c = 1; export let d = 1; }\n}\n";
      const stores = (main: string): readonly string[] =>
        reported({
          "src/lib.ts": LIB,
          "src/ns.ts": HW,
          "src/main.ts": `import { N } from "./ns.js";\n${main}N.a.kept();\nconsole.log(N.d, N.M.d);\n`,
          "src/dead.ts": DEAD,
        }).filter((line) => line.startsWith("DS1301 "));
      const named = stores("N.c = 2;\nN.M.c = 2;\n");
      expect(named).toEqual(["DS1301 N.M.c -", "DS1301 N.c -"]);
      for (const main of [
        'N["c"] = 2;\nN.M["c"] = 2;\n',
        'N["c"] = 2;\nN.M.c = 2;\n',
        'N.c = 2;\nN.M["c"] = 2;\n',
        "N[`c`] = 2;\nN.M[`c`] = 2;\n",
        'N.c = 2;\nN.M["c"] += 2;\n',
      ]) {
        expect(stores(main), main).toEqual(named);
      }
      // Any other store reads the namespace it stores into whole.
      expect(stores('declare const k: "c";\nN[k] = 2;\nN.M[k] = 2;\n')).toEqual([]);
      expect(stores('declare const k: "c";\nN.c = 2;\nN.M[k] = 2;\n')).toEqual(["DS1301 N.c -"]);
    },
    LOAD_TIMEOUT * 8,
  );

  it(
    "reads a nested namespace whole through a nested object pattern and through a binding, and by name through a flat one (references-ts.4, .5)",
    () => {
      const NESTED =
        'import * as lib from "./lib.js";\nexport namespace N {\n  export namespace M {\n' +
        "    export const space = lib;\n    export function f(): number { return 1; }\n  }\n}\n";
      const nested = (main: string): readonly string[] =>
        reported({
          "src/lib.ts": LIB,
          "src/ns.ts": NESTED,
          "src/main.ts": `import { N } from "./ns.js";\n${main}`,
          "src/dead.ts": DEAD,
        });
      expect(nested("const { f } = N.M;\nconsole.log(f());\n")).toContain(
        "DS1001 onlyDead reachability",
      );
      for (const main of [
        "const { M: { f } } = N;\nconsole.log(f());\n",
        "const { M } = N;\nconsole.log(M.f());\n",
        "const { M: alias } = N;\nconsole.log(alias.f());\n",
        "const { M } = N;\nvoid M;\n",
        "const { M } = N;\nconsole.log(M);\n",
        "export function run(): number {\n  const { M } = N;\n  return M.f();\n}\nrun();\n",
      ]) {
        expect(deadOf(nested(main), ["onlyDead", "kept"]), main).toEqual([]);
      }
    },
    LOAD_TIMEOUT * 6,
  );

  it(
    "passes a namespace on through a re-export of it, which is no use by itself (references-ts.4)",
    () => {
      for (const [label, barrel, main, dead] of [
        [
          "named",
          'export { N } from "./ns.js";\n',
          'import { N } from "./barrel.js";\nconsole.log(N.f());\n',
          true,
        ],
        [
          "renamed",
          'export { N as R } from "./ns.js";\n',
          'import { R } from "./barrel.js";\nconsole.log(R.f());\n',
          true,
        ],
        [
          "local",
          'import { N } from "./ns.js";\nexport { N };\n',
          'import { N } from "./barrel.js";\nconsole.log(N.f());\n',
          true,
        ],
        // A whole read behind the re-export uses the holder, which passes `lib` on whole.
        [
          "used whole",
          'export { N } from "./ns.js";\n',
          'import { N } from "./barrel.js";\nconsole.log(N);\n',
          false,
        ],
      ] as const) {
        const found = reported({
          "src/lib.ts": LIB,
          "src/ns.ts": FN,
          "src/barrel.ts": barrel,
          "src/main.ts": main,
          "src/dead.ts": DEAD,
        });
        if (dead) {
          expect(found, label).toContain("DS1001 onlyDead reachability");
        } else {
          expect(found, label).not.toContain("DS1001 onlyDead reachability");
        }
      }
    },
    LOAD_TIMEOUT * 6,
  );
});

describe("a whole read of a namespace value reads every export and member, through every level (references-ts.3, .5)", () => {
  const NESTED_FN =
    "export namespace N {\n  export namespace M {\n    export function f(): number { return 1; }\n" +
    "    export function g(): number { return 2; }\n  }\n}\n";
  const SUB =
    "export function f(): number { return 1; }\nexport function g(): number { return 2; }\n";
  const TOP = 'export * as sub from "./sub.js";\nexport function own(): number { return 3; }\n';

  it(
    "reads a nested namespace's members through a whole read of the namespace holding it, under both relations",
    () => {
      for (const main of [
        "console.log(N);\n",
        "export function use(x: unknown): void { console.log(x); }\nuse(N);\n",
        "const s = N;\nconsole.log(s);\n",
        "console.log(N.M);\n",
      ]) {
        const found = reported({
          "src/ns.ts": NESTED_FN,
          "src/main.ts": `import { N } from "./ns.js";\n${main}`,
        });
        expect(deadOf(found, ["N.M", "N.M.f", "N.M.g"]), main).toEqual([]);
      }
    },
    LOAD_TIMEOUT * 4,
  );

  it(
    "reads a module's nested namespace objects through a whole read of it, whatever re-export nests them, and ends at a cycle",
    () => {
      for (const [label, files, names] of [
        [
          "export * as",
          {
            "src/sub.ts": SUB,
            "src/lib.ts": TOP,
            "src/main.ts": 'import * as lib from "./lib.js";\nconsole.log(lib);\n',
          },
          ["f", "g", "own"],
        ],
        [
          "a re-exported namespace",
          {
            "src/ns.ts": "export namespace N { export function f(): void {} }\n",
            "src/lib.ts": 'export { N } from "./ns.js";\n',
            "src/main.ts": 'import * as lib from "./lib.js";\nconsole.log(lib);\n',
          },
          ["N.f"],
        ],
        [
          "an awaited import held whole",
          {
            "src/sub.ts": SUB,
            "src/lib.ts": TOP,
            "src/main.ts": 'const m = await import("./lib.js");\nconsole.log(m);\n',
          },
          ["f", "g", "own"],
        ],
        [
          "three levels",
          {
            "src/sub2.ts": SUB,
            "src/sub.ts": 'export * as deep from "./sub2.js";\n',
            "src/lib.ts": 'export * as sub from "./sub.js";\n',
            "src/main.ts": 'import * as lib from "./lib.js";\nconsole.log(lib.sub);\n',
          },
          ["f", "g"],
        ],
        [
          "a cycle",
          {
            "src/a.ts": 'export * as self from "./a.js";\nexport function f(): void {}\n',
            "src/main.ts": 'import * as a from "./a.js";\nconsole.log(a);\n',
          },
          ["f"],
        ],
      ] as const) {
        expect(deadOf(reported(files), names), label).toEqual([]);
      }
      // A read by name through the nested namespace reads the member it names alone.
      const named = reported({
        "src/sub.ts": SUB,
        "src/lib.ts": TOP,
        "src/main.ts": 'import * as lib from "./lib.js";\nconsole.log(lib.sub.f());\n',
      });
      expect(deadOf(named, ["f"])).toEqual([]);
      expect(deadOf(named, ["g", "own"])).toHaveLength(2);
    },
    LOAD_TIMEOUT * 6,
  );

  it(
    "reads the statics of a class and the members of an enum merged with a namespace through a whole read of it, and a plain class's none",
    () => {
      const MCLS =
        "export class C { n = 1; static s(): void {} static t(): void {} }\nexport namespace C { export const x = 1; }\n";
      const PCLS = "export class C { n = 1; static s(): void {} static t(): void {} }\n";
      const ENUM =
        "export enum E { A = 1, B = 2 }\nexport namespace E { export function f(): void {} }\n";
      const USE = "export function use(x: unknown): void { console.log(x); }\n";
      for (const [label, file, main, names] of [
        ["new", MCLS, "console.log(new C().n, C.x);\n", ["C.s", "C.t", "C.x"]],
        [
          "extends",
          MCLS,
          "class D extends C {}\nconsole.log(new D().n, C.x);\n",
          ["C.s", "C.t", "C.x"],
        ],
        ["an argument", MCLS, `${USE}use(C);\n`, ["C.s", "C.t", "C.x"]],
        ["an enum as an argument", ENUM, `${USE}use(E);\n`, ["E.A", "E.B", "E.f"]],
      ] as const) {
        const imported = label.includes("enum")
          ? 'import { E } from "./e.js";\n'
          : 'import { C } from "./e.js";\n';
        const found = reported({ "src/e.ts": file, "src/main.ts": `${imported}${main}` });
        expect(deadOf(found, names), label).toEqual([]);
      }
      // A read by name reads what it names alone; a plain class is no namespace value.
      expect(
        deadOf(
          reported({ "src/e.ts": MCLS, "src/main.ts": 'import { C } from "./e.js";\nC.s();\n' }),
          ["C.t", "C.x"],
        ),
      ).toHaveLength(2);
      expect(
        deadOf(
          reported({
            "src/e.ts": PCLS,
            "src/main.ts": `import { C } from "./e.js";\n${USE}use(C);\n`,
          }),
          ["C.s", "C.t"],
        ),
      ).toHaveLength(2);
    },
    LOAD_TIMEOUT * 6,
  );

  it(
    "reads every member of what an unanswered name may stand for, a namespace declaration and a merged class or enum among them (references-ts.5, program.33)",
    () => {
      const NS =
        "export namespace N {\n  export function f(): number { return 1; }\n  export function g(): number { return 2; }\n}\n";
      const USE = "export function use(x: unknown): void { console.log(x); }\n";
      for (const [label, files, path, before, names] of [
        [
          "an imported namespace",
          { "src/ns.ts": NS, "src/main.ts": 'import { N } from "./ns.js";\nconsole.log(N);\n' },
          "src/main.ts",
          "N);",
          ["N.f", "N.g"],
        ],
        [
          "a script's own namespace",
          {
            "src/main.ts":
              "namespace N {\n  export function f(): number { return 1; }\n  export function g(): number { return 2; }\n}\nconsole.log(N);\n",
          },
          "src/main.ts",
          "N);",
          ["N.f", "N.g"],
        ],
        [
          "a nested namespace",
          {
            "src/ns.ts": NESTED_FN,
            "src/main.ts": 'import { N } from "./ns.js";\nconsole.log(N);\n',
          },
          "src/main.ts",
          "N);",
          ["N.M", "N.M.f", "N.M.g"],
        ],
        [
          "a merged class",
          {
            "src/c.ts":
              "export class C { static s(): void {} static t(): void {} }\nexport namespace C { export const x = 1; }\n",
            "src/main.ts": `import { C } from "./c.js";\n${USE}use(C);\n`,
          },
          "src/main.ts",
          "C);",
          ["C.s", "C.t", "C.x"],
        ],
        [
          "a merged enum",
          {
            "src/e.ts":
              "export enum E { A = 1, B = 2 }\nexport namespace E { export function f(): void {} }\n",
            "src/main.ts": `import { E } from "./e.js";\n${USE}use(E);\n`,
          },
          "src/main.ts",
          "E);",
          ["E.A", "E.B", "E.f"],
        ],
        [
          "a module",
          {
            "src/lib.ts": SUB,
            "src/main.ts": 'import * as lib from "./lib.js";\nconsole.log(lib);\n',
          },
          "src/main.ts",
          "lib);",
          ["f", "g"],
        ],
      ] as const) {
        expect(deadOf(reportedFailing(files, path, before), names), label).toEqual([]);
      }
    },
    LOAD_TIMEOUT * 6,
  );
});

describe("an object binding pattern of names reads only the members it names as a variable's name, and the value whole anywhere else (references-ts.4, .5)", () => {
  const pattern = (
    main: string,
    imported = 'import * as lib from "./lib.js";\n',
  ): readonly string[] =>
    reported({ "src/lib.ts": LIB, "src/dead.ts": DEAD, "src/main.ts": `${imported}${main}` });
  const FORMS = [
    "export function take({ kept } = lib): void { kept(); }\ntake();\n",
    "export const take = ({ kept } = lib): void => { kept(); };\ntake();\n",
    "export function run(source: { box?: { kept(): void } }): void {\n  const { box: { kept } = lib } = source;\n  kept();\n}\nrun({});\n",
  ];

  it(
    "reads the value whole through a parameter's default and a nested element's default, on a module and on a namespace",
    () => {
      expect(pattern("const { kept } = lib;\nkept();\n")).toContain("DS1001 onlyDead reachability");
      for (const main of FORMS) {
        expect(deadOf(pattern(main), ["kept", "onlyDead"]), main).toEqual([]);
      }
      const NS_LIB =
        "export namespace L {\n  export function kept(): void {}\n  export function onlyDead(): void {}\n}\n";
      for (const main of FORMS.map((one) => one.replaceAll("= lib", "= L"))) {
        const found = reported({
          "src/l.ts": NS_LIB,
          "src/dead.ts": 'import { L } from "./l.js";\nL.onlyDead();\n',
          "src/main.ts": `import { L } from "./l.js";\n${main}`,
        });
        expect(deadOf(found, ["L.kept", "L.onlyDead"]), main).toEqual([]);
      }
    },
    LOAD_TIMEOUT * 6,
  );

  it(
    "reads every member through such a pattern with a rest element or a computed name",
    () => {
      for (const main of [
        "export function take({ kept, ...rest } = lib): void { kept(); console.log(rest); }\ntake();\n",
        'export function take({ ["kept"]: k } = lib): void { k(); }\ntake();\n',
      ]) {
        expect(pattern(main), main).not.toContain("DS1001 onlyDead reachability");
      }
    },
    LOAD_TIMEOUT * 2,
  );
});

describe("a re-export a root names, an unanswered alias and a type position are whole uses, under both relations (references-ts.4, .5)", () => {
  const SUBS = "export function f(): void {}\nexport function g(): void {}\n";
  const NESTED_NS =
    "export namespace N {\n  export namespace M {\n    export function f(): void {}\n" +
    "    export function g(): void {}\n  }\n}\n";
  const MERGED_FN =
    "export function F(): number { return 1; }\n" +
    "export namespace F { export function helper(): number { return 2; } }\n";
  const LIB_SUB = 'export * as sub from "./sub.js";\nexport function own(): void {}\n';
  const ROOTED = [
    [
      "a named re-export of `export * as`",
      {
        "src/sub.ts": SUBS,
        "src/lib.ts": LIB_SUB,
        "src/main.ts": 'export { sub } from "./lib.js";\n',
      },
      ["f", "g"],
    ],
    [
      "a re-export of a function merged with a namespace",
      { "src/lib.ts": MERGED_FN, "src/main.ts": 'export { F } from "./lib.js";\n' },
      ["F.helper"],
    ],
    [
      "a re-export of a nested namespace",
      { "src/ns.ts": NESTED_NS, "src/main.ts": 'export { N } from "./ns.js";\n' },
      ["N.M", "N.M.f", "N.M.g"],
    ],
  ] as const;

  it(
    "keeps every export a root's re-export passes on, on an application and a library, and nothing it does not",
    () => {
      for (const library of [false, true]) {
        for (const [label, files, names] of ROOTED) {
          const found = reported(files, undefined, library);
          expect(deadOf(found, names), `${label}, library ${String(library)}`).toEqual([]);
        }
        const [, withOwn] = ROOTED[0];
        expect(
          reported(withOwn, undefined, library).filter((line) => line.split(" ")[1] === "own"),
          "what the re-export does not pass on stays reported",
        ).toHaveLength(1);
      }
      const barrel = reported({
        "src/sub.ts": SUBS,
        "src/lib.ts": LIB_SUB,
        "src/barrel.ts": 'export { sub } from "./lib.js";\n',
        "src/main.ts": 'import { sub } from "./barrel.js";\nsub.f();\n',
      });
      expect(deadOf(barrel, ["f"]), "a reached barrel keeps what is read").toEqual([]);
      expect(barrel, "and nothing more").toContain("DS1001 g reference-counting");
    },
    LOAD_TIMEOUT * 8,
  );

  it(
    "passes nothing on to reference counting from a re-export a suppression marks, which no root names",
    () => {
      const files = {
        "src/sub.ts": SUBS,
        "src/main.ts": 'import "./barrel.js";\nconsole.log(1);\n',
      };
      const BARREL = 'export * as sub from "./sub.js";\n';
      // A mark is no root, no use these rules leave unjudged and no re-export so used (.4).
      expect(
        analyzed({
          ...files,
          "src/barrel.ts": `// deadset:ignore DS1001 -- kept for a plugin\n${BARREL}`,
        }),
      ).toEqual(["DS1001 f reference-counting", "DS1001 g reference-counting"]);
      expect(analyzed({ ...files, "src/barrel.ts": BARREL }), "unmarked").toEqual([
        "DS1001 f reference-counting",
        "DS1001 g reference-counting",
        "DS1001 sub reference-counting",
      ]);
      // The same mark on an export specifier of a namespace import, unread and read by name.
      const SPECIFIER =
        'import * as sub from "./sub.js";\n// deadset:ignore DS1001 -- kept for a plugin\nexport { sub };\n';
      expect(analyzed({ ...files, "src/barrel.ts": SPECIFIER }), "a specifier").toEqual([
        "DS1001 f reference-counting",
        "DS1001 g reference-counting",
      ]);
      expect(
        analyzed({
          ...files,
          "src/barrel.ts": SPECIFIER,
          "src/main.ts": 'import { sub } from "./barrel.js";\nconsole.log(sub.f());\n',
        }),
        "a specifier read by name",
      ).toEqual(["DS1001 g reference-counting"]);
    },
    LOAD_TIMEOUT * 4,
  );

  it(
    "reads every module and namespace a name the checker fails on behind a renaming alias may stand for",
    () => {
      const NS =
        "export namespace N {\n  export function f(): number { return 1; }\n  export function g(): number { return 2; }\n}\n";
      for (const [label, files, before, names] of [
        [
          "a named import of `export * as`",
          {
            "src/sub.ts": SUBS,
            "src/lib.ts": 'export * as sub from "./sub.js";\n',
            "src/main.ts": 'import { sub } from "./lib.js";\nconsole.log(sub);\n',
          },
          "sub);",
          ["f", "g"],
        ],
        [
          "a renamed re-export",
          {
            "src/ns.ts": NS,
            "src/mid.ts": 'export { N as M } from "./ns.js";\n',
            "src/main.ts": 'import { M } from "./mid.js";\nconsole.log(M);\n',
          },
          "M);",
          ["N.f", "N.g"],
        ],
        [
          "a default export",
          {
            "src/ns.ts": NS,
            "src/mid.ts": 'import { N } from "./ns.js";\nexport default N;\n',
            "src/main.ts": 'import D from "./mid.js";\nconsole.log(D);\n',
          },
          "D);",
          ["N.f", "N.g"],
        ],
        [
          "a member of a namespace import",
          {
            "src/sub.ts": SUBS,
            "src/lib.ts": 'export * as sub from "./sub.js";\n',
            "src/main.ts": 'import * as lib from "./lib.js";\nconsole.log(lib.sub);\n',
          },
          "sub);",
          ["f", "g"],
        ],
      ] as const) {
        expect(deadOf(reportedFailing(files, "src/main.ts", before), names), label).toEqual([]);
      }
    },
    LOAD_TIMEOUT * 6,
  );

  it(
    "reads a class, enum, interface or function merged with a namespace whole where a type names it",
    () => {
      const CLS =
        "export class C { static s(): void {} static t(): void {} n = 1; }\n" +
        "export namespace C { export const x = 1; export const y = 2; }\n";
      const ENUM =
        "export enum E { A = 1, B = 2 }\n" +
        "export namespace E { export function f(): void {} export function g(): void {} }\n";
      const IFNS =
        "export interface P { a: number }\nexport namespace P {\n" +
        "  export function make(): P { return { a: 1 }; }\n  export function unused(): void {}\n}\n";
      const FNS =
        "export function F(): number { return 1; }\n" +
        "export namespace F { export interface O { a: number } export function used(): void {} export function unused(): void {} }\n";
      const forms = [
        [
          "const v: E",
          {
            "src/e.ts": ENUM,
            "src/main.ts":
              'import { E } from "./e.js";\nconst v: E = E.A;\nconsole.log(v);\nE.f();\n',
          },
          ["E.g", "E.B"],
        ],
        [
          "a parameter's type",
          {
            "src/c.ts": CLS,
            "src/main.ts":
              'import { C } from "./c.js";\nexport function make(c: C): number { return c.n; }\nC.s();\nconsole.log(C.x, make);\n',
          },
          ["C.t", "C.y"],
        ],
        [
          "implements",
          {
            "src/c.ts": CLS,
            "src/main.ts":
              'import { C } from "./c.js";\nexport class D implements C { n = 2; }\nC.s();\nconsole.log(C.x, new D());\n',
          },
          ["C.t", "C.y"],
        ],
        [
          "E[]",
          {
            "src/e.ts": ENUM,
            "src/main.ts":
              'import { E } from "./e.js";\nconst v: E[] = [E.A];\nconsole.log(v);\nE.f();\n',
          },
          ["E.g", "E.B"],
        ],
        [
          "type K = E",
          {
            "src/e.ts": ENUM,
            "src/main.ts":
              'import { E } from "./e.js";\nexport type K = E;\nconsole.log(E.A);\nE.f();\n',
          },
          ["E.g", "E.B"],
        ],
        [
          "F.O's qualifier",
          {
            "src/f.ts": FNS,
            "src/main.ts":
              'import { F } from "./f.js";\nconst o: F.O = { a: F() };\nF.used();\nconsole.log(o);\n',
          },
          ["F.unused"],
        ],
        [
          "const p: P",
          {
            "src/p.ts": IFNS,
            "src/main.ts": 'import { P } from "./p.js";\nconst p: P = P.make();\nconsole.log(p);\n',
          },
          ["P.unused"],
        ],
        [
          "Array<P>",
          {
            "src/p.ts": IFNS,
            "src/main.ts":
              'import { P } from "./p.js";\nconst ps: Array<P> = [P.make()];\nconsole.log(ps);\n',
          },
          ["P.unused"],
        ],
        [
          "a return type",
          {
            "src/c.ts": CLS,
            "src/main.ts":
              'import { C } from "./c.js";\nexport function get(): C | undefined { return undefined; }\nC.s();\nconsole.log(C.x, get());\n',
          },
          ["C.t", "C.y"],
        ],
        [
          "typeof E",
          {
            "src/e.ts": ENUM,
            "src/main.ts":
              'import { E } from "./e.js";\nexport type T = typeof E;\nconsole.log(E.A);\nE.f();\n',
          },
          ["E.g", "E.B"],
        ],
        [
          '(typeof E)["f"]',
          {
            "src/e.ts": ENUM,
            "src/main.ts":
              'import { E } from "./e.js";\nexport type T = (typeof E)["f"];\nconsole.log(E.A);\nE.f();\n',
          },
          ["E.g", "E.B"],
        ],
      ] as const;
      for (const [label, files, names] of forms) {
        expect(deadOf(reported(files), names), label).toEqual([]);
      }
      expect(
        reported({
          "src/e.ts": ENUM,
          "src/main.ts": 'import { E } from "./e.js";\nconst v = E.A;\nconsole.log(v);\nE.f();\n',
        }),
        "a value read by name alone stays precise",
      ).toEqual(
        expect.arrayContaining(["DS1001 E.g reference-counting", "DS1005 E.B reference-counting"]),
      );
    },
    LOAD_TIMEOUT * 12,
  );

  it(
    "reads a namespace value whole through a nested or defaulted pattern and a parameter's pattern",
    () => {
      const M =
        "export namespace M { export function f(): void {} export function g(): void {} }\n";
      const DEAD_MG = 'import { M } from "./m.js";\nM.g();\n';
      for (const main of [
        'import * as m from "./m.js";\nexport function take({ M: { f } } = m): void { f(); }\ntake();\n',
        'import * as m from "./m.js";\nconst { M: { f } } = m;\nf();\n',
        'import * as m from "./m.js";\nexport function run(source: { box?: typeof m }): void {\n  const { box: { M: { f } } = m } = source;\n  f();\n}\nrun({});\n',
        'import * as m from "./m.js";\nconst { M: { f } }: { M: { f(): void } } = m;\nf();\n',
        'import * as m from "./m.js";\nconst { M = m.M } = m;\nM.f();\n',
      ]) {
        const found = reported({ "src/m.ts": M, "src/dead.ts": DEAD_MG, "src/main.ts": main });
        expect(deadOf(found, ["M.f", "M.g"]), main).toEqual([]);
      }
      expect(
        reported({
          "src/m.ts": M,
          "src/dead.ts": DEAD_MG,
          "src/main.ts": 'import * as m from "./m.js";\nconst { f } = m.M;\nf();\n',
        }),
        "a flat pattern of names reads only those",
      ).toContain("DS1001 M.g reachability");
    },
    LOAD_TIMEOUT * 6,
  );
});

describe("a const or a then callback's first parameter given a namespace object binds it, and each read is judged where it is read (references-ts.4, .5)", () => {
  const X =
    "export function show(): void {}\nexport function spare(): void {}\nexport function _seam(): void {}\n";
  const SEAM =
    'import { it } from "vitest";\nimport { _seam } from "./x.js";\nit("s", () => {\n  _seam();\n});\n';
  const binding = (main: string, extra: Readonly<Record<string, string>> = {}): readonly string[] =>
    reported({ ...extra, "src/x.ts": X, "src/x.test.ts": SEAM, "src/main.ts": main });
  const IMPORT = 'import * as x from "./x.js";\n';
  const TAKE = "function take(value: unknown): void {\n  console.log(value);\n}\n";
  const BOUND = [
    ["a then callback's pattern", 'void import("./x.js").then(({ show }) => {\n  show();\n});\n'],
    ["a then callback's name", 'void import("./x.js").then((m) => {\n  m.show();\n});\n'],
    [
      "a returned then callback's pattern",
      'export function go(): Promise<void> {\n  return import("./x.js").then(({ show }) => {\n    show();\n  });\n}\nvoid go();\n',
    ],
    [
      "a then callback's name read in a closure",
      'void import("./x.js").then((m) => {\n  const run = (): void => m.show();\n  run();\n});\n',
    ],
    [
      "an awaited import's const",
      'export async function go(): Promise<void> {\n  const m = await import("./x.js");\n  m.show();\n}\nvoid go();\n',
    ],
    [
      "a const of a namespace import",
      `${IMPORT}export function go(): void {\n  const m = x;\n  m["show"]();\n}\ngo();\n`,
    ],
    [
      "a const of a const",
      `${IMPORT}export function go(): void {\n  const m = x;\n  const n = m;\n  n.show();\n}\ngo();\n`,
    ],
    ["a module's const nothing exports", `${IMPORT}const m = x;\nm.show();\n`],
    [
      "an arrow callback beside an own object's arguments and caller properties",
      'const o = { arguments: 1, caller: 2 };\nconsole.log(o.arguments, o["caller"]);\nvoid import("./x.js").then((m) => {\n  m.show();\n});\n',
    ],
    [
      "an arrow callback in a program that reads a function's arguments",
      'function peek(f: Function): unknown {\n  return f.arguments;\n}\nconsole.log(peek(peek));\nvoid import("./x.js").then((m) => {\n  m.show();\n});\n',
    ],
    [
      "an arrow callback whose eval is a namespace of the program",
      'export {};\nnamespace eval {\n  export const x = 1;\n}\nvoid import("./x.js").then((m) => {\n  (eval as unknown as (s: string) => void)("m.spare()");\n  m.show();\n});\n',
    ],
    ["a parenthesized arrow callback", 'void import("./x.js").then(((m) => {\n  m.show();\n}));\n'],
  ] as const;

  it(
    "reads only the member each read names, so a test seam and an unread export are reported",
    () => {
      for (const [label, main] of BOUND) {
        const found = binding(main);
        expect(found, label).toContain("DS1001 spare reference-counting");
        expect(found, label).toContain("DS1102 _seam reference-counting");
        expect(deadOf(found, ["show"]), label).toEqual([]);
      }
    },
    LOAD_TIMEOUT * 12,
  );

  it(
    "reads the value whole where the binding escapes, is reassigned or read another way, or is no such binding",
    () => {
      for (const [label, main] of [
        ["passed", 'void import("./x.js").then((m) => {\n  console.log(m);\n});\n'],
        [
          "returned",
          'export async function go(): Promise<unknown> {\n  const m = await import("./x.js");\n  return m;\n}\nvoid go();\n',
        ],
        [
          "spread",
          `${IMPORT}export function go(): unknown {\n  const m = x;\n  return { ...m };\n}\ngo();\n`,
        ],
        [
          "stored",
          `${IMPORT}const box: { v?: unknown } = {};\nexport function go(): void {\n  const m = x;\n  box.v = m;\n}\ngo();\n`,
        ],
        [
          "keyed",
          `${IMPORT}export function go(k: string): void {\n  const m = x;\n  console.log(m[k as keyof typeof m]);\n}\ngo("show");\n`,
        ],
        [
          "reassigned parameter",
          'void import("./x.js").then((m) => {\n  m = m;\n  m.show();\n});\n',
        ],
        ["a let", `${IMPORT}export function go(): void {\n  let m = x;\n  m.show();\n}\ngo();\n`],
        [
          "a typed const",
          `${IMPORT}export function go(): void {\n  const m: Record<string, () => void> = x;\n  m["show"]?.();\n}\ngo();\n`,
        ],
        ["an exported const", `${IMPORT}export const m = x;\nm.show();\n`],
        [
          "a const an export specifier carries",
          `${IMPORT}const m = x;\nm.show();\nexport { m };\n`,
        ],
        [
          "a const a default export carries",
          `${IMPORT}const m = x;\nm.show();\nexport default m;\n`,
        ],
        [
          "a defaulted then parameter",
          'void import("./x.js").then((m = undefined) => {\n  m?.show();\n});\n',
        ],
        [
          "a nested then pattern",
          'void import("./x.js").then(({ show: run, ...rest }) => {\n  run();\n  console.log(rest);\n});\n',
        ],
        // A function callback binds nothing, whatever it reads: its parameter, its pattern and the
        // call with no parameter hold the value.
        [
          "a function callback's name",
          'void import("./x.js").then(function (m) {\n  m.show();\n});\n',
        ],
        [
          "a function callback's name read in a closure",
          'void import("./x.js").then(function (m) {\n  const run = (): void => m.show();\n  run();\n});\n',
        ],
        [
          "a function callback's pattern",
          'void import("./x.js").then(function ({ show }) {\n  show();\n});\n',
        ],
        [
          "a function callback with no parameter",
          'void import("./x.js").then(function () {\n  console.log(1);\n});\n',
        ],
        [
          "a function callback's first parameter after a this parameter",
          'void import("./x.js").then(function (this: void, m) {\n  m.show();\n});\n',
        ],
        [
          "a function callback with an own name nothing refers to",
          'void import("./x.js").then(function named(m) {\n  m.show();\n});\n',
        ],
        [
          "a function callback beside an own object's arguments and caller properties",
          'const o = { arguments: 1, caller: 2 };\nconsole.log(o.arguments, o["caller"]);\nvoid import("./x.js").then(function (m) {\n  m.show();\n});\n',
        ],
        [
          "a parenthesized function callback",
          'void import("./x.js").then((function (m) {\n  m.show();\n}));\n',
        ],
        [
          "an async function callback",
          'void import("./x.js").then(async function (m) {\n  m.show();\n});\n',
        ],
        [
          "a function callback that passes arguments on",
          `${TAKE}void import("./x.js").then(function (m) {\n  take(arguments[0]);\n  m.show();\n});\n`,
        ],
        [
          "a function callback that hands its own name out to a reader of arguments",
          'function peek(f: Function): void {\n  (f.arguments[0] as { spare(): void }).spare();\n}\nvoid import("./x.js").then(function cb(m) {\n  m.show();\n  peek(cb);\n});\n',
        ],
        [
          "a function callback that calls a reader of its caller",
          'function peek(): void {\n  const c = (peek as Function).caller as Function;\n  (c.arguments[0] as { spare(): void }).spare();\n}\nvoid import("./x.js").then(function (m) {\n  m.show();\n  peek();\n});\n',
        ],
      ] as const) {
        expect(deadOf(binding(main), ["show", "spare", "_seam"]), label).toEqual([]);
      }
    },
    LOAD_TIMEOUT * 26,
  );

  it(
    "binds nothing to a function callback, whose arguments object code it calls may read through its function object, and keeps the same program's arrow callback precise",
    () => {
      const SCRIPT = {
        "tsconfig.json": JSON.stringify({
          compilerOptions: {
            strict: true,
            allowJs: true,
            checkJs: false,
            target: "ESNext",
            module: "NodeNext",
            moduleResolution: "nodenext",
            noEmit: true,
          },
        }),
        "package.json": '{ "name": "@example/m", "private": true }\n',
        "src/lib.mjs": "export function show() {}\nexport function spare() {}\n",
      };
      const script = (main: string, entry: string): readonly string[] =>
        analyzed({
          ...SCRIPT,
          "deadset.json": JSON.stringify({
            target: { kind: "application" },
            analysis: { min_confidence: "possible" },
            ts: { entry_files: [entry] },
          }),
          [entry]: main,
        });
      const KEYS = { "src/keys.ts": 'export const caller = "nope";\n' };
      const COMPUTED =
        'function peek(f: Function): void {\n  const key = "arguments";\n  (f[key][0] as { spare(): void }).spare();\n}\n';
      const AS_CONST =
        'function peek(): void {\n  const c = peek["caller" as const] as Function;\n  (c["arguments" as const][0] as { spare(): void }).spare();\n}\n';
      const SATISFIES =
        'function peek(): void {\n  const c = peek["caller" satisfies "caller"] as Function;\n  (c["arguments" satisfies "arguments"][0] as { spare(): void }).spare();\n}\n';
      const DESTRUCTURED =
        "const o = { arguments: 1, caller: 2 };\nconst { arguments: a, caller: c } = o;\nvoid a;\nvoid c;\n";
      const ALIASED =
        'import { caller } from "./keys.js";\nconst f = function (): void {};\nvoid f[caller];\n';
      const JOINED =
        'function take(o) {\n  const k = ["argu", "ments"].join("");\n  o.f[k][0].spare();\n}\n';
      const KEYED =
        'function peek() {\n  const a = ["cal", "ler"].join(""), b = ["argu", "ments"].join("");\n  peek[a][b][0].spare();\n}\n';
      const REFLECTED =
        'function peek() {\n  const c = Reflect.get(peek, "caller");\n  Reflect.get(c, "arguments")[0].spare();\n}\n';
      const PARENTHESIZED =
        'function peek() {\n  const c = peek[("caller")];\n  c[("arguments")][0].spare();\n}\n';
      const THEN = 'import("./lib.mjs").then(';
      // Each program runs the callback's own `arguments[0]`, the namespace object, through a route
      // the checker does not resolve, so the export it calls is live.
      for (const [label, main, extra] of [
        [
          "a function callback that hands itself out as a shorthand to a computed reader",
          `${COMPUTED}void import("./x.js").then(function cb(m) {\n  m.show();\n  const box = { cb };\n  peek(box.cb);\n});\n`,
        ],
        [
          "a function callback that calls a reader of its caller by an as const index",
          `${AS_CONST}void import("./x.js").then(function (m) {\n  m.show();\n  peek();\n});\n`,
        ],
        [
          "a function callback that calls a reader of its caller by a satisfies index",
          `${SATISFIES}void import("./x.js").then(function (m) {\n  m.show();\n  peek();\n});\n`,
        ],
        [
          "a function callback beside an own object's destructured arguments and caller",
          `${DESTRUCTURED}void import("./x.js").then(function (m) {\n  m.show();\n});\n`,
        ],
        [
          "a function callback beside a function indexed by an imported name",
          `${ALIASED}void import("./x.js").then(function (m) {\n  m.show();\n});\n`,
          KEYS,
        ],
      ] as const) {
        expect(deadOf(binding(main, extra), ["show", "spare", "_seam"]), label).toEqual([]);
      }
      for (const [label, main, entry] of [
        [
          "a CommonJS script's function callback that hands itself out as a shorthand",
          `${JOINED}${THEN}function f(m) {\n  take({ f });\n  m.show();\n});\n`,
          "src/main.cjs",
        ],
        [
          "a CommonJS script's function callback that calls a reader of its caller by a computed key",
          `${KEYED}${THEN}function (m) {\n  peek();\n  m.show();\n});\n`,
          "src/main.cjs",
        ],
        [
          "a CommonJS script's function callback that calls a reader of its caller through Reflect",
          `${REFLECTED}${THEN}function (m) {\n  peek();\n  m.show();\n});\n`,
          "src/main.cjs",
        ],
        [
          "a CommonJS script's function callback that calls a reader of its caller by a parenthesized index",
          `${PARENTHESIZED}${THEN}function (m) {\n  m.show();\n  peek();\n});\n`,
          "src/main.js",
        ],
      ] as const) {
        expect(deadOf(script(main, entry), ["show", "spare"]), label).toEqual([]);
      }
      // An arrow has no `arguments` object of its own, and its function object's `caller` and
      // `arguments` throw, so the same programs leave its binding precise.
      for (const [label, main, extra] of [
        [
          "an arrow callback beside a computed reader",
          `${COMPUTED}void import("./x.js").then((m) => {\n  m.show();\n  const box = { cb: peek };\n  peek(box.cb);\n});\n`,
        ],
        [
          "an arrow callback that calls a reader of its caller by an as const index",
          `${AS_CONST}void import("./x.js").then((m) => {\n  m.show();\n  peek();\n});\n`,
        ],
        [
          "an arrow callback that calls a reader of its caller by a satisfies index",
          `${SATISFIES}void import("./x.js").then((m) => {\n  m.show();\n  peek();\n});\n`,
        ],
        [
          "an arrow callback beside an own object's destructured arguments and caller",
          `${DESTRUCTURED}void import("./x.js").then((m) => {\n  m.show();\n});\n`,
        ],
        [
          "an arrow callback beside a function indexed by an imported name",
          `${ALIASED}void import("./x.js").then((m) => {\n  m.show();\n});\n`,
          KEYS,
        ],
      ] as const) {
        const found = binding(main, extra);
        expect(found, label).toContain("DS1001 spare reference-counting");
        expect(found, label).toContain("DS1102 _seam reference-counting");
        expect(deadOf(found, ["show"]), label).toEqual([]);
      }
      for (const [label, main, entry] of [
        [
          "a CommonJS script's arrow callback beside a shorthand handed to a reader",
          `${JOINED}${THEN}(m) => {\n  take({ f: take });\n  m.show();\n});\n`,
          "src/main.cjs",
        ],
        [
          "a CommonJS script's arrow callback that calls a reader of its caller by a computed key",
          `${KEYED}${THEN}(m) => {\n  peek();\n  m.show();\n});\n`,
          "src/main.cjs",
        ],
        [
          "a CommonJS script's arrow callback that calls a reader of its caller through Reflect",
          `${REFLECTED}${THEN}(m) => {\n  peek();\n  m.show();\n});\n`,
          "src/main.cjs",
        ],
        [
          "a CommonJS script's arrow callback that calls a reader of its caller by a parenthesized index",
          `${PARENTHESIZED}${THEN}(m) => {\n  m.show();\n  peek();\n});\n`,
          "src/main.js",
        ],
      ] as const) {
        const found = script(main, entry);
        expect(found, label).toContain("DS1001 spare reference-counting");
        expect(deadOf(found, ["show"]), label).toEqual([]);
      }
    },
    LOAD_TIMEOUT * 18,
  );

  it(
    "reads whole every namespace binding a direct eval can see, at any depth, whatever form binds it, and no binding an indirect or shadowed eval or one out of scope can",
    () => {
      const THEN = 'void import("./x.js").then(';
      for (const [label, main] of [
        [
          "an arrow callback's eval",
          `${TAKE}${THEN}(m) => {\n  m.show();\n  take(eval("m"));\n});\n`,
        ],
        [
          "an eval in a nested function of an arrow callback",
          `${TAKE}${THEN}(m) => {\n  function inner(): unknown {\n    return eval("m");\n  }\n  take(inner());\n  m.show();\n});\n`,
        ],
        ["a namespace import", `${IMPORT}${TAKE}x.show();\ntake(eval("x"));\n`],
        [
          "an awaited import's const",
          `${TAKE}export async function go(): Promise<void> {\n  const m = await import("./x.js");\n  m.show();\n  take(eval("m"));\n}\nvoid go();\n`,
        ],
        [
          "a const of a namespace import",
          `${IMPORT}${TAKE}export function go(): void {\n  const m = x;\n  m.show();\n  take(eval("m"));\n}\ngo();\n`,
        ],
        [
          "a parenthesized eval in an arrow callback",
          `${TAKE}${THEN}(m) => {\n  m.show();\n  take((eval)("m"));\n});\n`,
        ],
        [
          "an eval under a type assertion",
          `${TAKE}${THEN}(m) => {\n  m.show();\n  take((eval as typeof eval)("m"));\n});\n`,
        ],
        [
          "an eval under a non-null assertion",
          `${TAKE}${THEN}(m) => {\n  m.show();\n  take(eval!("m"));\n});\n`,
        ],
        [
          "an eval three functions deep",
          `${IMPORT}${TAKE}x.show();\nfunction a(): unknown {\n  function b(): unknown {\n    const c = (): unknown => eval("x");\n    return c();\n  }\n  return b();\n}\ntake(a());\n`,
        ],
      ] as const) {
        expect(deadOf(binding(main), ["show", "spare", "_seam"]), label).toEqual([]);
      }
      const SUB =
        "export function f(): number {\n  return 1;\n}\nexport function g(): number {\n  return 2;\n}\n";
      const NS =
        "namespace N {\n  export function f(): number {\n    return 1;\n  }\n  export function g(): number {\n    return 2;\n  }\n}\nconsole.log(N.f());\n";
      expect(
        deadOf(
          reported({
            "src/sub.ts": SUB,
            "src/ns.ts": 'export * as sub from "./sub.js";\n',
            "src/main.ts": `${TAKE}import { sub } from "./ns.js";\nsub.f();\ntake(eval("sub"));\n`,
          }),
          ["f", "g", "sub"],
        ),
        "a named import of export * as",
      ).toEqual([]);
      expect(
        deadOf(reported({ "src/main.ts": `${TAKE}${NS}take(eval("N"));\n` }), ["N.f", "N.g"]),
        "a namespace declaration",
      ).toEqual([]);
      expect(
        reported({ "src/main.ts": `${TAKE}${NS}take((0, eval)("N"));\n` }),
        "a namespace declaration beside an indirect eval",
      ).toContain("DS1001 N.g reference-counting");
      for (const [label, main] of [
        ["an indirect eval", `${TAKE}${THEN}(m) => {\n  m.show();\n  take((0, eval)("m"));\n});\n`],
        [
          "a comma of two evals",
          `${TAKE}${THEN}(m) => {\n  m.show();\n  take((eval, eval)("m"));\n});\n`,
        ],
        [
          "an optional call of eval",
          `${TAKE}${THEN}(m) => {\n  m.show();\n  take(eval?.("m"));\n});\n`,
        ],
        [
          "an eval in a sibling function",
          `${TAKE}${THEN}(m) => {\n  m.show();\n});\nfunction other(): unknown {\n  return eval("1");\n}\ntake(other());\n`,
        ],
        [
          "a member named eval",
          `${TAKE}const o = { eval: (s: string): string => s };\n${THEN}(m) => {\n  m.show();\n  take(o.eval("m"));\n});\n`,
        ],
      ] as const) {
        const found = binding(main);
        expect(found, label).toContain("DS1001 spare reference-counting");
        expect(deadOf(found, ["show"]), label).toEqual([]);
      }
      const other = reported({
        "src/x.ts": X,
        "src/other.ts": `${TAKE}take(eval("1"));\n`,
        "src/main.ts": `import "./other.js";\n${IMPORT}x.show();\n`,
      });
      expect(other, "an eval in another file").toContain("DS1001 spare reference-counting");
      // An eval in code nothing reaches reads under reference counting alone.
      const unreached = reported({
        "src/x.ts": X,
        "src/main.ts": `${IMPORT}x.show();\nfunction never(): unknown {\n  return eval("x");\n}\n`,
      });
      expect(unreached, "an unreached eval").toContain("DS1001 spare reachability");
      expect(deadOf(unreached, ["show"]), "an unreached eval").toEqual([]);
      expect(unreached, "an unreached eval").not.toContain("DS1001 spare reference-counting");
    },
    LOAD_TIMEOUT * 20,
  );

  it(
    "binds no namespace object in a file that holds a with statement, which may read names the checker does not resolve, and keeps every other file's bindings precise, whatever its strictness",
    () => {
      const SCRIPT = {
        "tsconfig.json": JSON.stringify({
          compilerOptions: {
            strict: false,
            allowJs: true,
            checkJs: false,
            jsx: "preserve",
            target: "ESNext",
            module: "NodeNext",
            moduleResolution: "nodenext",
            noEmit: true,
          },
        }),
        "package.json": '{ "name": "@example/m", "private": true }\n',
        "src/lib.mjs": "export function show() {}\nexport function spare() {}\n",
      };
      const MODULE = '{ "name": "@example/m", "private": true, "type": "module" }\n';
      const THEN = 'import("./lib.mjs").then(';
      const script = (main: string, entry = "src/main.cjs", manifest?: string): readonly string[] =>
        analyzed({
          ...SCRIPT,
          "deadset.json": JSON.stringify({
            target: { kind: "application" },
            analysis: { min_confidence: "possible" },
            ts: { entry_files: [entry] },
          }),
          ...(manifest === undefined ? {} : { "package.json": manifest }),
          [entry]: main,
        });
      for (const [label, main, entry, manifest] of [
        [
          "a with body naming the binding",
          `const o = {};\n${THEN}(m) => {\n  with (o) {\n    m.show();\n  }\n});\n`,
        ],
        [
          "a with body in a nested function",
          `const o = {};\n${THEN}(m) => {\n  function a() {\n    with (o) {\n      return m.show();\n    }\n  }\n  a();\n});\n`,
        ],
        [
          "an eval in a with body",
          `const o = {};\n${THEN}(m) => {\n  m.show();\n  with (o) {\n    console.log(eval("m"));\n  }\n});\n`,
        ],
        ["an eval", `${THEN}(m) => {\n  m.show();\n  console.log(eval("m"));\n});\n`],
        [
          "a then callback inside a with body",
          `const o = {};\nwith (o) {\n  ${THEN}(m) => {\n    m.show();\n  });\n}\n`,
        ],
        [
          "a then callback in a function inside a with body",
          `const o = {};\nwith (o) {\n  function f() {\n    ${THEN}(m) => {\n      m.show();\n    });\n  }\n  f();\n}\n`,
        ],
        [
          "an awaited import's const inside a with body",
          `const o = {};\nasync function go() {\n  with (o) {\n    const m = await import("./lib.mjs");\n    m.show();\n  }\n}\ngo();\n`,
        ],
        [
          "a whole use inside a with body",
          `const o = {};\nwith (o) {\n  ${THEN}console.log);\n}\n`,
        ],
        [
          "an awaited import read whole inside a with body",
          `const o = {};\nasync function go() {\n  with (o) {\n    console.log(await import("./lib.mjs"));\n  }\n}\ngo();\n`,
        ],
        [
          "a strict arrow inside a with body",
          `const o = {};\nwith (o) {\n  ${THEN}(m) => {\n    "use strict";\n    m.show();\n  });\n}\n`,
        ],
        // A `with` anywhere in the file, whatever it names, leaves no binding of the file precise.
        [
          "a with body naming another name",
          `const o = {};\n${THEN}(m) => {\n  m.show();\n  with (o) {\n    console.log(1);\n  }\n});\n`,
        ],
        [
          "a with statement in another function of the file",
          `function other(o) {\n  with (o) {\n    return 1;\n  }\n}\nother({});\n${THEN}(m) => {\n  m.show();\n});\n`,
        ],
        [
          "an awaited import's const beside a with statement",
          `function other(o) {\n  with (o) {\n    return 1;\n  }\n}\nother({});\nasync function go() {\n  const m = await import("./lib.mjs");\n  m.show();\n}\ngo();\n`,
        ],
        // A function callback binds nothing in any file.
        ["a CommonJS script's function callback", `${THEN}function (m) {\n  m.show();\n});\n`],
        [
          "a .js file of a type module package with no module syntax, its function callback",
          `${THEN}function (m) {\n  m.show();\n});\n`,
          "src/main.js",
          MODULE,
        ],
      ] as const) {
        expect(deadOf(script(main, entry, manifest), ["show", "spare"]), label).toEqual([]);
      }
      // No strictness is decided: a script, a module and every directive bind alike where no
      // `with` statement is written.
      for (const [label, main, entry, manifest] of [
        ["a CommonJS script", `${THEN}(m) => {\n  m.show();\n});\n`],
        [
          "a var shadowing eval",
          `${THEN}(m) => {\n  var eval = function (s) {\n    return s;\n  };\n  m.show();\n  console.log(eval("m"));\n});\n`,
        ],
        [
          "a parameter shadowing eval",
          `function run(eval) {\n  return ${THEN}(m) => {\n    m.show();\n    return eval("m");\n  });\n}\nrun(function (s) {\n  return s;\n});\n`,
        ],
        [
          "an awaited import's const in a script",
          `async function go() {\n  const m = await import("./lib.mjs");\n  m.show();\n}\ngo();\n`,
        ],
        [
          "a directive written with an escape",
          `"use\\x20strict";\n${THEN}(m) => {\n  m.show();\n});\n`,
        ],
        [
          "a directive after a statement",
          `console.log(1);\n"use strict";\n${THEN}(m) => {\n  m.show();\n});\n`,
        ],
        ["a module named .mjs", `${THEN}(m) => {\n  m.show();\n});\n`, "src/main.mjs"],
        [
          "a module's awaited import's const",
          'const m = await import("./lib.mjs");\nm.show();\n',
          "src/main.mjs",
        ],
        [
          "a file with module syntax",
          `export {};\n${THEN}(m) => {\n  m.show();\n});\n`,
          "src/main.js",
          MODULE,
        ],
        [
          "a .js file of a type module package with no module syntax",
          `${THEN}(m) => {\n  m.show();\n});\n`,
          "src/main.js",
          MODULE,
        ],
        [
          "a .js file of a type module package with no module syntax, its awaited const",
          'async function go() {\n  const m = await import("./lib.mjs");\n  m.show();\n}\ngo();\n',
          "src/main.js",
          MODULE,
        ],
        [
          "a .jsx file of a type module package with no module syntax",
          `${THEN}(m) => {\n  m.show();\n});\n`,
          "src/main.jsx",
          MODULE,
        ],
        ["a script under use strict", `"use strict";\n${THEN}(m) => {\n  m.show();\n});\n`],
        ["an arrow under use strict", `${THEN}(m) => {\n  "use strict";\n  m.show();\n});\n`],
        [
          "a class method",
          `class K {\n  run() {\n    ${THEN}(m) => {\n      m.show();\n    });\n  }\n}\nnew K().run();\n`,
        ],
        // A pattern of names reads its members where it is evaluated and binds no namespace object.
        ["a then pattern", `${THEN}({ show }) => {\n  show();\n});\n`],
        [
          "a then pattern inside a with body",
          `const o = {};\nwith (o) {\n  ${THEN}({ show }) => {\n    show();\n  });\n}\n`,
        ],
      ] as const) {
        const found = script(main, entry, manifest);
        expect(found, label).toContain("DS1001 spare reference-counting");
        expect(deadOf(found, ["show"]), label).toEqual([]);
      }
    },
    LOAD_TIMEOUT * 34,
  );

  it(
    "binds a dynamic import by the module its specifier names, a CommonJS module's interop object included, and holds one written with a type of its own",
    () => {
      const LIB =
        "export function show(): void {}\nexport function spare(): void {}\nexport function _seam(): void {}\n";
      const NODE = JSON.stringify({
        compilerOptions: {
          strict: true,
          allowJs: true,
          checkJs: false,
          target: "ESNext",
          module: "NodeNext",
          moduleResolution: "nodenext",
          noEmit: true,
          allowImportingTsExtensions: true,
        },
        include: ["src/**/*"],
      });
      const COMMONJS = '{ "name": "@example/m", "private": true }\n';
      const formatted = (
        main: string,
        lib: string,
        manifest = '{ "name": "@example/m", "private": true, "type": "module" }\n',
      ): readonly string[] =>
        reported({
          "tsconfig.json": NODE,
          "package.json": manifest,
          [lib]: LIB,
          "src/x.test.ts": `import { it } from "vitest";\nimport { _seam } from "./${lib.slice(4)}";\nit("s", () => {\n  _seam();\n});\n`,
          "src/main.ts": main,
        });
      for (const [label, main, lib, manifest] of [
        [
          "a then callback's name, a CommonJS module imported from an ES module",
          'void import("./lib.cts").then((m) => {\n  m.show();\n});\n',
          "src/lib.cts",
        ],
        [
          "an awaited import's const, a CommonJS module imported from an ES module",
          'const m = await import("./lib.cts");\nm.show();\n',
          "src/lib.cts",
        ],
        [
          "a then callback's name, a CommonJS module imported from a module of a CommonJS package",
          'export {};\nvoid import("./lib.ts").then((m) => {\n  m.show();\n});\n',
          "src/lib.ts",
          COMMONJS,
        ],
        [
          "a then callback's default member, read through",
          'export {};\nvoid import("./lib.ts").then((m) => {\n  m.default.show();\n});\n',
          "src/lib.ts",
          COMMONJS,
        ],
        [
          "a const of a then callback's default member",
          'export {};\nvoid import("./lib.ts").then((m) => {\n  const d = m.default;\n  d.show();\n});\n',
          "src/lib.ts",
          COMMONJS,
        ],
        [
          "a CommonJS script's arrow callback",
          'void import("./lib.mts").then((m) => {\n  m.show();\n});\n',
          "src/lib.mts",
          COMMONJS,
        ],
        [
          "a CommonJS script's awaited const",
          'async function go(): Promise<void> {\n  const m = await import("./lib.ts");\n  m.show();\n}\nvoid go();\n',
          "src/lib.ts",
          COMMONJS,
        ],
        [
          "a then pattern written with a type of its own",
          'void import("./lib.ts").then(({ show }: { show(): void }) => {\n  show();\n});\n',
          "src/lib.ts",
        ],
      ] as const) {
        const found = formatted(main, lib, manifest);
        expect(found, label).toContain("DS1001 spare reference-counting");
        expect(found, label).toContain("DS1102 _seam reference-counting");
        expect(deadOf(found, ["show"]), label).toEqual([]);
      }
      for (const [label, main, lib, manifest] of [
        [
          "a then callback's default member and a member",
          'export {};\nvoid import("./lib.ts").then((m) => {\n  m.show();\n  m.default.spare();\n});\n',
          "src/lib.ts",
          COMMONJS,
        ],
        [
          "a then callback's default member passed on",
          'export {};\nvoid import("./lib.ts").then((m) => {\n  m.show();\n  console.log(m.default);\n});\n',
          "src/lib.ts",
          COMMONJS,
        ],
        [
          "a namespace import's default member of a CommonJS module passed on",
          'import * as ns from "./lib.cts";\nns.show();\nconsole.log(ns.default);\n',
          "src/lib.cts",
        ],
        [
          "a then callback's name written with a type of its own",
          'void import("./lib.ts").then((m: { show(): void }) => {\n  m.show();\n});\n',
          "src/lib.ts",
        ],
        [
          "an awaited import's const written with a type of its own",
          'const m: { show(): void } = await import("./lib.ts");\nm.show();\n',
          "src/lib.ts",
        ],
        // A function callback binds nothing, whatever reads it.
        [
          "a CommonJS script's function callback",
          'void import("./lib.mts").then(function cb(m) {\n  m.show();\n});\n',
          "src/lib.mts",
          COMMONJS,
        ],
        [
          "a CommonJS script's function callback that hands its own name to a reader of arguments",
          'function peek(f: Function): void {\n  (f.arguments[0] as { spare(): void; _seam(): void }).spare();\n}\nvoid import("./lib.mts").then(function cb(m) {\n  m.show();\n  peek(cb);\n});\n',
          "src/lib.mts",
          COMMONJS,
        ],
      ] as const) {
        expect(deadOf(formatted(main, lib, manifest), ["show", "spare", "_seam"]), label).toEqual(
          [],
        );
      }
      // A JSDoc type is the declaration's type too.
      const documented = (main: string): readonly string[] =>
        analyzed({
          "tsconfig.json": NODE,
          "deadset.json": JSON.stringify({
            target: { kind: "application" },
            analysis: { min_confidence: "possible" },
            ts: { entry_files: ["src/main.js"] },
          }),
          "src/lib.js": "export function show() {}\nexport function spare() {}\n",
          "src/main.js": main,
        });
      for (const [label, main] of [
        [
          "a then callback's name under a JSDoc param type",
          'import("./lib.js").then(/** @param {{ show(): void }} m */ (m) => {\n  m.show();\n});\n',
        ],
        [
          "an awaited import's const under a JSDoc type",
          '/** @type {{ show(): void }} */\nconst m = await import("./lib.js");\nm.show();\n',
        ],
      ] as const) {
        expect(deadOf(documented(main), ["show", "spare"]), label).toEqual([]);
      }
      expect(
        documented('import("./lib.js").then((m) => {\n  m.show();\n});\n'),
        "a then callback's name with no JSDoc type",
      ).toContain("DS1001 spare reference-counting");
    },
    LOAD_TIMEOUT * 20,
  );

  it(
    "reads every module and namespace where the checker fails at the binding, at what it is given or at a whole read of it, and the member alone a failed read by name names",
    () => {
      for (const [label, main, before] of [
        [
          "a then callback's name",
          'void import("./x.js").then((m) => {\n  m.show();\n});\n',
          "m) =>",
        ],
        [
          "an awaited import's const",
          'export async function go(): Promise<void> {\n  const m = await import("./x.js");\n  m.show();\n}\nvoid go();\n',
          " m = await",
        ],
        ["a const of a namespace import", `${IMPORT}const m = x;\nm.show();\n`, " x;"],
        ["a whole read", 'void import("./x.js").then((m) => {\n  console.log(m);\n});\n', "m);"],
      ] as const) {
        const found = reportedFailing(
          { "src/x.ts": X, "src/x.test.ts": SEAM, "src/main.ts": main },
          "src/main.ts",
          before,
        );
        expect(deadOf(found, ["show", "spare"]), label).toEqual([]);
      }
      // A read by name the checker fails at reads no more than the member its name resolves to.
      // A place is a node's position before its leading trivia, as the checker is asked it.
      const byName = reportedFailing(
        {
          "src/x.ts": X,
          "src/x.test.ts": SEAM,
          "src/main.ts": 'void import("./x.js").then((m) => {\n  m.show();\n});\n',
        },
        "src/main.ts",
        "\n  m.show",
      );
      expect(byName).toContain("DS1001 spare reference-counting");
      expect(deadOf(byName, ["show"])).toEqual([]);
    },
    LOAD_TIMEOUT * 6,
  );
});
