import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { fixture } from "../__test-helpers__/fixtures.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import { runSweep, type RunSweep } from "./analysis.ts";
import { defaultConfig } from "./config.ts";
import { discoverProjects } from "./discover.ts";
import type { Evidence } from "./exempt.ts";
import { interfaceSatisfaction } from "./interface-satisfaction.ts";
import { inventory, type Inventory } from "./inventory.ts";
import { resolve } from "./resolve.ts";
import { run, type Writer } from "./run.ts";
import { scopeForDir } from "./scope.ts";
import { openEngine, runSession } from "./session.ts";

const TARGET = fixture("projects", "interface-satisfaction");

/** The fixture swept for production under its own configuration, with the shipped detectors. */
function sweepFixture(): RunSweep {
  const document = join(TARGET, "deadset.json");
  const { config } = resolve({
    repository: readFileSync(document, "utf8"),
    repositoryLabel: document,
  });
  const host = nodeHost();
  return runSweep(openEngine({ collectTiming: true }), host, scopeForDir(host, TARGET), config, {
    marked: [],
    mode: { production: true },
  });
}

/** What one swept application holds back by this class, and the members it reports dead. */
interface Swept {
  /** Each record as `<member> <detail> <line>`. */
  readonly retained: readonly string[];
  readonly dead: readonly string[];
}

/**
 * One application written from `files` and entered at `main.ts`, swept for production
 * with the shipped detectors, the tree removed afterwards.
 */
function sweepWritten(files: Readonly<Record<string, string>>): Swept {
  const root = writeProject({
    "package.json": JSON.stringify({ name: "@example/written", private: true, type: "module" }),
    ...files,
  });
  try {
    const { config } = resolve({
      repository: JSON.stringify({
        target: { kind: "application" },
        ts: { entry_files: ["main.ts"] },
      }),
      repositoryLabel: "deadset.json",
    });
    const host = nodeHost();
    const swept = runSweep(
      openEngine({ collectTiming: false }),
      host,
      scopeForDir(host, root),
      config,
      { marked: [], mode: { production: true } },
    );
    const names = retainedNames(swept);
    return {
      retained: swept.retained.flatMap((held, index) =>
        held.class === "interface-satisfaction"
          ? [`${names[index] ?? held.id} ${held.detail} ${String(held.site.line)}`]
          : [],
      ),
      dead: deadMembers(swept),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The display name of each retained record's declaration. */
function retainedNames(swept: RunSweep): string[] {
  return swept.retained.map(
    (held) => swept.matrix.union.symbols.find((symbol) => symbol.id === held.id)?.name ?? held.id,
  );
}

/** The display names of the members the sweep reports dead. */
function deadMembers(swept: RunSweep): string[] {
  return swept.sweep.candidates
    .map(
      (candidate) =>
        swept.matrix.union.symbols.find((symbol) => symbol.id === candidate.id)?.name ?? "",
    )
    .filter((name) => name.includes("."));
}

/** What the detector found over the fixture's one project, and the client requests it made. */
interface Measured {
  readonly held: Inventory;
  readonly evidence: readonly Evidence[];
  readonly requests: number;
}

/** The client requests the detector made over one project written from `files`. */
function requestsOf(files: Readonly<Record<string, string>>): number {
  const root = writeProject(files);
  try {
    return measure(root).requests;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function measure(root = TARGET): Measured {
  const host = nodeHost();
  const engine = openEngine({ collectTiming: true });
  const { configFiles } = discoverProjects(engine, host, scopeForDir(host, root));
  const { projects } = runSession(engine, configFiles, (project) => {
    const held = inventory(project, host, root);
    const before = engine.getTimingInfo().totals.requestCount;
    const evidence = interfaceSatisfaction({
      project,
      held,
      targetRoot: root,
      templates: { delimiters: { left: "{{", right: "}}" }, files: [] },
      ts: defaultConfig().ts,
      consumers: [],
    });
    return { held, evidence, requests: engine.getTimingInfo().totals.requestCount - before };
  });
  const [only] = projects;
  if (only === undefined) {
    throw new Error("the fixture opened no project");
  }
  return only;
}

describe("interface satisfaction", () => {
  it("retains the members an interface requires of each class whose value reaches it, by every flow", () => {
    expect(retainedNames(sweepFixture())).toEqual([
      "Assigned.area",
      "Passed.label",
      "Returned.label",
      "Returned.size",
      "Stored.area",
      "Pushed.label",
      "Base.label",
      "Boxed.label",
      "Declared.label",
    ]);
  });

  it("reports every member no reached interface requires, and the members of a class whose values reach none", () => {
    expect(deadMembers(sweepFixture())).toEqual([
      "Assigned.spare",
      "Passed.spare",
      "Returned.spare",
      "Stored.spare",
      "Pushed.spare",
      "Derived.spare",
      "Declared.spare",
      "Unconverted.area",
      "Unconverted.label",
    ]);
  });

  it("records each member at the place the value flows, the clause for a declared one", () => {
    const sites = sweepFixture().retained.map(
      (held) => `${held.detail} ${held.site.path}:${String(held.site.line)}`,
    );

    expect(sites).toEqual([
      "satisfies Shape src/main.ts:27",
      "satisfies Named src/main.ts:37",
      "satisfies Sized src/main.ts:23",
      "satisfies Sized src/main.ts:23",
      "satisfies Shape src/main.ts:28",
      "satisfies Named src/main.ts:30",
      "satisfies Named src/main.ts:38",
      "satisfies Named src/main.ts:39",
      "satisfies Named src/classes.ts:84",
    ]);
  });

  it("asks the client one batch for the positions, one for the pairs, one question per interface and per argument", () => {
    const { requests } = measure();
    // Reading the conversion set: one batched type lookup over the class names, the
    // clause and the values; one target lookup for the first array type a value
    // carries, the project declaring a generic class; one batch of contextual lookups
    // over the seven values whose type is a class of the target.
    const reading = 1 + 1 + 1;
    // The eight pairs, asked in one batch: Assigned, Stored and Shape; Passed, Derived,
    // Boxed<number>, Pushed, Declared and Named; Returned and Sized.
    const pairs = 1;
    // One property list for each of Shape, Named and Sized.
    const interfaces = 3;
    // One property list for each class of a satisfied pair, naming its members.
    const classes = 8;
    // The signature each of the four calls taking a value resolves to; for the generic
    // `push`, the signature it instantiates, the parameter's type there and its constraint.
    const signatures = 4 + 3;

    expect(requests).toBe(reading + interfaces + pairs + classes + signatures);
  });
});

class MemoryWriter implements Writer {
  text = "";
  write(text: string): void {
    this.text += text;
  }
}

describe("print-retained over a project whose values reach interfaces", () => {
  it("prints each held-back member with its class, site and detail, and exits 0", async () => {
    const out = new MemoryWriter();
    const err = new MemoryWriter();

    expect(run(["print-retained", `--target=${TARGET}`], out, err, nodeHost())).toBe(0);
    expect(err.text).toBe("");
    await expect(
      out.text,
      "regenerate with `npx vitest --run -u src/interface-satisfaction.test.ts` and review the diff",
    ).toMatchFileSnapshot(fixture("golden", "interface-satisfaction.retained.txt"));
  });
});

/** The interface, and a call reading it, that the written cases below share. */
const NAMED = [
  "export interface Named {",
  "  label(): string;",
  "}",
  "",
  "export function describe(named: Named): string {",
  "  return named.label();",
  "}",
  "",
].join("\n");

/** One written case: `main.ts` importing {@link NAMED} from `named.ts`, then `lines`. */
function written(lines: readonly string[]): Readonly<Record<string, string>> {
  return {
    "named.ts": NAMED,
    "main.ts": ['import { describe, type Named } from "./named.ts";', "", ...lines, ""].join("\n"),
  };
}

describe("a class whose own `this` reaches an interface", () => {
  it.each([
    ["as an argument", "return describe(this);"],
    ["as an object property", "return keep({ named: this });"],
  ])(
    "retains what the interface requires of it, where an instance method hands it on %s",
    (_, body) => {
      expect(
        sweepWritten(
          written([
            "function keep(holder: { readonly named: Named }): string {",
            "  return holder.named.label();",
            "}",
            "",
            "class Self {",
            "  label(): string {",
            '    return "self";',
            "  }",
            "",
            "  spare(): number {",
            "    return 0;",
            "  }",
            "",
            "  run(): string {",
            `    ${body}`,
            "  }",
            "}",
            "",
            "console.log(new Self().run());",
          ]),
        ),
      ).toEqual({ retained: ["Self.label satisfies Named 17"], dead: ["Self.spare"] });
    },
  );

  it.each([
    [
      "a function declaration",
      [
        "run(): string {",
        "  function nested(this: Named): string {",
        "    return describe(this);",
        "  }",
        '  return nested.call({ label: () => "other" });',
        "}",
      ],
      "new Plain().run()",
    ],
    [
      "a function expression",
      [
        "run(): string {",
        "  const nested = function (this: Named): string {",
        "    return describe(this);",
        "  };",
        '  return nested.call({ label: () => "other" });',
        "}",
      ],
      "new Plain().run()",
    ],
    [
      "an object literal's method",
      [
        "run(): string {",
        '  return { label: (): string => "other", read(): string { return describe(this); } }.read();',
        "}",
      ],
      "new Plain().run()",
    ],
    [
      "a static method",
      [
        "static label(): string {",
        '  return "static";',
        "}",
        "",
        "static run(): string {",
        "  return describe(this);",
        "}",
      ],
      "Plain.run()",
    ],
    [
      "a static block",
      [
        "static label(): string {",
        '  return "static";',
        "}",
        "",
        "static {",
        "  describe(this);",
        "}",
      ],
      "Plain",
    ],
  ])("holds back nothing where `this` in %s stands for another value", (_, members, use) => {
    const swept = sweepWritten(
      written([
        "class Plain {",
        "  label(): string {",
        '    return "plain";',
        "  }",
        "",
        ...members.map((line) => (line === "" ? "" : `  ${line}`)),
        "}",
        "",
        `console.log(${use});`,
      ]),
    );

    expect(swept.retained).toEqual([]);
    expect(swept.dead).toContain("Plain.label");
  });
});

describe("a class value reaching an interface through a typed position", () => {
  it("retains what the interface requires of a generic class's instantiation", () => {
    expect(
      sweepWritten(
        written([
          "class Boxed<T> {",
          "  constructor(readonly value: T) {}",
          "",
          "  label(): string {",
          '    return "boxed";',
          "  }",
          "",
          "  spare(): number {",
          "    return 0;",
          "  }",
          "}",
          "",
          "console.log(describe(new Boxed(1)).length);",
        ]),
      ),
    ).toEqual({ retained: ["Boxed.label satisfies Named 15"], dead: ["Boxed.spare"] });
  });

  it("reaches each interface of a union and of an intersection, and none it is not assignable to", () => {
    expect(
      sweepWritten(
        written([
          "interface Sized {",
          "  size(): number;",
          "}",
          "",
          "interface Measured {",
          "  size(): number;",
          "  readonly unit: string;",
          "}",
          "",
          "function optional(named?: Named): string {",
          '  return named?.label() ?? "";',
          "}",
          "",
          "function both(value: Named & Sized): number {",
          "  return value.size() + value.label().length;",
          "}",
          "",
          "function either(value: Named | Measured): string {",
          '  return "label" in value ? value.label() : value.unit + String(value.size());',
          "}",
          "",
          "class Optional {",
          "  label(): string {",
          '    return "optional";',
          "  }",
          "",
          "  size(): number {",
          "    return 0;",
          "  }",
          "}",
          "",
          "class Both {",
          "  label(): string {",
          '    return "both";',
          "  }",
          "",
          "  size(): number {",
          "    return 1;",
          "  }",
          "}",
          "",
          "class Either {",
          "  label(): string {",
          '    return "either";',
          "  }",
          "",
          "  size(): number {",
          "    return 2;",
          "  }",
          "}",
          "",
          "console.log(optional(new Optional()), both(new Both()), either(new Either()));",
        ]),
      ),
    ).toEqual({
      retained: [
        "Optional.label satisfies Named 54",
        "Both.label satisfies Named 54",
        "Both.size satisfies Sized 54",
        "Either.label satisfies Named 54",
      ],
      dead: ["Optional.size", "Either.size"],
    });
  });

  it("reaches the constraint of a generic call's parameter at the argument's own place", () => {
    expect(
      sweepWritten(
        written([
          "function pair<A, T extends Named>(first: A, second: T): string {",
          "  return String(first) + second.label();",
          "}",
          "",
          "class Second {",
          "  label(): string {",
          '    return "second";',
          "  }",
          "",
          "  spare(): number {",
          "    return 0;",
          "  }",
          "}",
          "",
          "console.log(pair(1, new Second()));",
        ]),
      ),
    ).toEqual({ retained: ["Second.label satisfies Named 17"], dead: ["Second.spare"] });
  });

  it("records a member at every place a class's value reaches an interface, a test file's first", () => {
    expect(
      sweepWritten({
        "named.ts": NAMED,
        "plain.ts": [
          "export class Plain {",
          "  label(): string {",
          '    return "plain";',
          "  }",
          "}",
          "",
        ].join("\n"),
        "a.test.ts": [
          'import { describe } from "./named.ts";',
          'import { Plain } from "./plain.ts";',
          "",
          "describe(new Plain());",
          "",
        ].join("\n"),
        "main.ts": [
          'import { describe } from "./named.ts";',
          'import { Plain } from "./plain.ts";',
          "",
          "const plain = new Plain();",
          "console.log(describe(plain));",
          "",
        ].join("\n"),
      }).retained,
    ).toEqual(["Plain.label satisfies Named 5"]);
  });

  it("holds back nothing for a class entry of an extends clause", () => {
    expect(
      sweepWritten({
        "main.ts": [
          "interface Base {",
          "  extra(): string;",
          "}",
          "",
          "class Base {",
          "  label(): string {",
          '    return "base";',
          "  }",
          "}",
          "",
          "class Derived extends Base {",
          "  extra(): string {",
          '    return "extra";',
          "  }",
          "}",
          "",
          "function use(base: Base): string {",
          "  return base.extra();",
          "}",
          "",
          "console.log(use(new Base()), new Derived().label());",
          "",
        ].join("\n"),
      }),
    ).toEqual({ retained: [], dead: ["Derived.extra"] });
  });
});

describe("a class reaching an interface whose members nothing calls", () => {
  it("keeps a member implementing an interface property, which is read rather than called", () => {
    expect(
      sweepWritten({
        "main.ts": [
          "interface Labelled {",
          "  readonly label: string;",
          "}",
          "",
          "class Stored {",
          '  readonly label = "stored";',
          "  readonly spare = 0;",
          "}",
          "",
          "const labelled: Labelled = new Stored();",
          "console.log(labelled === undefined);",
          "",
        ].join("\n"),
      }),
    ).toEqual({
      retained: ["Stored.label satisfies Labelled 10"],
      dead: ["Labelled.label", "Stored.spare"],
    });
  });

  it("keeps a member implementing an interface the program's libraries declare", () => {
    expect(
      sweepWritten({
        "main.ts": [
          "class Handler {",
          "  handleEvent(): void {}",
          "",
          "  spare(): number {",
          "    return 0;",
          "  }",
          "}",
          "",
          'addEventListener("message", new Handler());',
          "",
        ].join("\n"),
      }),
    ).toEqual({
      retained: ["Handler.handleEvent satisfies EventListenerObject 9"],
      dead: ["Handler.spare"],
    });
  });
});

describe("the client requests of the detector", () => {
  it("are none for a project that declares no class", () => {
    expect(
      requestsOf(
        written([
          'const named: Named = { label: () => "literal" };',
          "console.log(describe(named));",
        ]),
      ),
    ).toBe(0);
  });

  it("ask no generic target where no class of the project is generic", () => {
    // One batch of types over the class's name and the values, and one of contextual
    // types over the value typed as the class; none for the target of the array type the
    // other value carries.
    const counted = requestsOf(
      written([
        "class Plain {",
        "  label(): string {",
        '    return "plain";',
        "  }",
        "}",
        "",
        "function all(list: readonly Named[]): number {",
        "  return list.length;",
        "}",
        "",
        "const plain: Plain[] = [new Plain()];",
        "console.log(all(plain));",
      ]),
    );

    expect(counted).toBe(1 + 1);
  });
});
