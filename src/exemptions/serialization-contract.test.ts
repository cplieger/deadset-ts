import { mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nodeHost } from "../../bin/node-host.ts";
import { emitterInputOf, findingsOf } from "../../__test-helpers__/emitter-input.ts";
import { fixture } from "../../__test-helpers__/fixtures.ts";
import { writeProject } from "../../__test-helpers__/projects.ts";
import { treeFindings } from "../../__test-helpers__/tree-findings.ts";
import { runSweep, type RunSweep } from "../analysis.ts";
import { resolve } from "../resolve.ts";
import { run, type Writer } from "../run.ts";
import { scopeForDir } from "../scope.ts";
import { openEngine } from "../session.ts";

const TARGET = fixture("projects", "serialization-contract");
const CHECKED = fixture("projects", "serialization-checked-and-ambient");

const LOAD_TIMEOUT = 60_000;

/** The fixture swept for production, under its own configuration or the one given. */
function sweepFixture(document?: string, target = TARGET): RunSweep {
  const path = join(target, "deadset.json");
  const { config } = resolve({
    repository: { text: document ?? readFileSync(path, "utf8"), label: path },
  });
  const host = nodeHost();
  return runSweep(openEngine({ collectTiming: false }), host, scopeForDir(host, target), config, {
    marked: [],
    mode: { production: true },
  });
}

/** The display name of one declaration of the run. */
function nameOf(swept: RunSweep, id: string): string {
  return swept.matrix.union.symbols.find((symbol) => symbol.id === id)?.name ?? id;
}

/** Each record of the class on a member of the named classes, with its site and detail. */
function serialized(swept: RunSweep, ...classes: readonly string[]): string[] {
  return swept.sweep.retained
    .filter((held) => held.class === "serialization-contract")
    .map(
      (held) =>
        `${nameOf(swept, held.id)} ${held.site.path}:${String(held.site.line)}:${String(held.site.column)} ${held.detail}`,
    )
    .filter((line) => classes.some((name) => line.startsWith(`${name}.`)));
}

/** Each member of the model the sweep reports dead. */
function deadMembers(swept: RunSweep): string[] {
  return swept.sweep.candidates
    .map((candidate) => nameOf(swept, candidate.id))
    .filter((name) => name.includes("."));
}

class MemoryWriter implements Writer {
  text = "";
  write(text: string): void {
    this.text += text;
  }
}

describe("serialization-contract", () => {
  const swept = sweepFixture();

  it("retains the properties of a class whose values reach a serializer, and those its properties carry", () => {
    expect(serialized(swept, "Order", "Item", "Payload", "Frame")).toEqual([
      "Order.id src/main.ts:45:16 passed to JSON.stringify",
      "Order.items src/main.ts:45:16 passed to JSON.stringify",
      "Item.sku src/main.ts:45:16 passed to JSON.stringify",
      "Payload.body src/main.ts:47:28 passed to Schema.parse",
      "Frame.bytes src/main.ts:48:8 passed to encode",
      "Frame.bytes src/wire.ts:4:17 passed to String",
    ]);
  });

  it("retains the conversion methods as well where the value leaves the analysis", () => {
    expect(serialized(swept, "Event")).toEqual([
      "Event.kind src/main.ts:46:13 passed to console.log",
      "Event.toString src/main.ts:46:13 passed to console.log",
      "Event.toJSON src/main.ts:46:13 passed to console.log",
    ]);
  });

  it("holds a function that hands its own unknown parameter on to what it hands it to", () => {
    expect(serialized(swept, "Message", "Relayed", "Traced")).toEqual([
      "Message.text src/main.ts:49:6 passed to send",
      "Relayed.text src/main.ts:50:7 passed to relay",
      "Traced.step src/main.ts:51:7 passed to trace",
      "Traced.toString src/main.ts:51:7 passed to trace",
    ]);
  });

  it("binds a function's arguments past its `this` parameter, which binds none", () => {
    expect(serialized(swept, "Bound")).toEqual(["Bound.id src/main.ts:60:11 passed to sendBound"]);
    expect(deadMembers(swept)).not.toContain("Bound.id");
  });

  it("binds every argument from a rest parameter's position on, past a `this` parameter", () => {
    expect(serialized(swept, "Leading", "Trailing")).toEqual([
      "Leading.id src/main.ts:61:9 passed to sendAll",
      "Trailing.id src/main.ts:61:24 passed to sendAll",
    ]);
    expect(deadMembers(swept)).not.toContain("Leading.id");
  });

  it("binds a method's arguments past its `this` parameter, which binds none", () => {
    expect(serialized(swept, "Posted")).toEqual([
      "Posted.id src/main.ts:62:20 passed to Courier.post",
    ]);
    expect(deadMembers(swept)).not.toContain("Posted.id");
  });

  it("binds a function expression's arguments past its `this` parameter where a variable holds it", () => {
    expect(serialized(swept, "VarBound")).toEqual([
      "VarBound.id src/main.ts:69:9 passed to sendVar",
    ]);
    expect(deadMembers(swept)).not.toContain("VarBound.id");
  });

  it("reads a call through Function.prototype.call, apply or bind as a call of the function", () => {
    expect(serialized(swept, "Called", "Applied", "Rebound", "Prebound")).toEqual([
      "Called.id src/main.ts:63:27 passed to JSON.stringify",
      "Applied.id src/main.ts:64:29 passed to JSON.stringify",
      "Rebound.id src/main.ts:65:27 passed to JSON.stringify",
      "Prebound.id src/main.ts:66:27 passed to JSON.stringify",
    ]);
  });

  it("reads the arguments of a call through Function.prototype.call against the callee's own parameters", () => {
    expect(serialized(swept, "Logged", "Dispatched")).toEqual([
      "Logged.kind src/main.ts:67:27 passed to console.log",
      "Logged.toString src/main.ts:67:27 passed to console.log",
      "Dispatched.text src/main.ts:68:22 passed to send",
    ]);
  });

  it("reads `this` in an instance member as a value of its class", () => {
    expect(serialized(swept, "Snapshot")).toEqual([
      "Snapshot.at src/model.ts:80:27 passed to JSON.stringify",
    ]);
  });

  it("reads `this` in a static member as the class, which holds back no instance member", () => {
    expect(serialized(swept, "Registry")).toEqual([]);
    expect(deadMembers(swept)).toContain("Registry.entries");
  });

  it("reads `this` in a nested function expression as its own, which holds back no instance member", () => {
    expect(serialized(swept, "Deferred")).toEqual([]);
    expect(deadMembers(swept)).toContain("Deferred.value");
  });

  it("reads `this` in a static block as the class, which holds back no instance member", () => {
    expect(serialized(swept, "Census")).toEqual([]);
    expect(deadMembers(swept)).toContain("Census.count");
  });

  it("reads `this` in a function declared in a method as its own, which holds back no instance member", () => {
    expect(serialized(swept, "Journal")).toEqual([]);
    expect(deadMembers(swept)).toContain("Journal.entry");
  });

  it("reads `this` in an object literal's methods and accessors as the object, which holds back no instance member", () => {
    expect(serialized(swept, "Outline")).toEqual([]);
    expect(deadMembers(swept)).toContain("Outline.depth");
  });

  it("reads `this` in an arrow function as the enclosing method's, a value of its class", () => {
    expect(serialized(swept, "Batch")).toEqual([
      "Batch.size src/model.ts:150:43 passed to JSON.stringify",
    ]);
    expect(deadMembers(swept)).not.toContain("Batch.size");
  });

  it("reports methods, accessors and private names, and what reaches no destination", () => {
    expect(deadMembers(swept)).toEqual([
      "Order.#secret",
      "Order.total",
      "Order.label",
      "Event.describe",
      "Registry.entries",
      "Deferred.value",
      "Census.count",
      "Journal.entry",
      "Outline.depth",
      "Kept.unused",
    ]);
  });

  it("reads JSON.stringify and the unknown parameters of ambient declarations where the configuration names no serializer, and a value an `object` parameter hands one", () => {
    const unconfigured = sweepFixture(JSON.stringify({ target: { kind: "application" } }));

    expect(serialized(unconfigured, "Order", "Payload", "Frame")).toEqual([
      "Order.id src/main.ts:45:16 passed to JSON.stringify",
      "Order.items src/main.ts:45:16 passed to JSON.stringify",
      'Payload.body src/main.ts:47:28 passed to object({body:""}).parse',
      "Frame.bytes src/wire.ts:4:17 passed to String",
    ]);
    expect(deadMembers(unconfigured)).not.toContain("Payload.body");
    expect(deadMembers(unconfigured)).not.toContain("Frame.bytes");
  });
});

describe("serialization-contract over checked values and ambient callees", () => {
  const swept = sweepFixture(undefined, CHECKED);

  it("reads the members of a `satisfies` target where the checked literal reaches a destination", () => {
    expect(serialized(swept, "Pushed", "Wrapped", "Asserted", "Annotated")).toEqual([
      "Pushed.kind src/main.ts:73:20 passed to client.postMessage",
      "Pushed.title src/main.ts:73:20 passed to client.postMessage",
      "Wrapped.reason src/main.ts:74:20 passed to client.postMessage",
      "Asserted.cause src/main.ts:75:20 passed to client.postMessage",
      "Annotated.body src/main.ts:77:20 passed to client.postMessage",
    ]);
  });

  it("reads the members of a `satisfies` target where the checked literal is stored in what a destination walks", () => {
    expect(serialized(swept, "Boxed", "Assigned")).toEqual([
      "Boxed.size src/main.ts:82:29 passed to JSON.stringify",
      "Assigned.step src/main.ts:82:56 passed to JSON.stringify",
    ]);
  });

  it("reads the operand's own type and each asserted type where an assertion erases them", () => {
    expect(serialized(swept, "Small", "Never", "AnyCast")).toEqual([
      "Small.tiny src/main.ts:152:20 passed to client.postMessage",
      "AnyCast.erased src/main.ts:154:20 passed to client.postMessage",
    ]);
  });

  it(
    "reads each type an assertion names, whose members are held where the program writes them",
    () => {
      expect(
        retainedIn([
          "interface Small { tiny: string }",
          "interface Other { ghost: string; unset?: string }",
          'const small: Small = { tiny: "s" };',
          'const other: Other = { ghost: "g" };',
          "console.log(JSON.stringify(small as unknown as Other), other.unset);",
        ]),
      ).toEqual([
        "Small.tiny 5:28 passed to JSON.stringify",
        "Other.ghost 5:28 passed to JSON.stringify",
      ]);
    },
    LOAD_TIMEOUT,
  );

  it("reads a value passed to an unknown parameter of a callee the project declares only ambiently", () => {
    expect(serialized(swept, "Broadcast", "Relayed", "Forwarded", "Dropped")).toEqual([
      "Broadcast.line src/main.ts:84:21 passed to channel.postMessage",
      "Relayed.hop src/main.ts:86:7 passed to relay",
      "Forwarded.leg src/main.ts:88:9 passed to forward",
    ]);
  });

  it("reports only what reaches no destination, a function or an implemented member of the project included", () => {
    const document = join(CHECKED, "deadset.json");
    const { config } = resolve({
      repository: { text: readFileSync(document, "utf8"), label: document },
    });

    expect(
      findingsOf(emitterInputOf(CHECKED, config)).map(
        (finding) =>
          `${finding.code} ${finding.position.path}:${String(finding.position.line)} ${finding.symbol.name}`,
      ),
    ).toEqual([
      "DS1003 src/main.ts:143 Never.ghost",
      "DS1301 src/main.ts:59 Dropped.gone",
      "DS1301 src/main.ts:70 Unsent.note",
      "DS1301 src/main.ts:94 HiddenD.viaDts",
      "DS1301 src/main.ts:109 HiddenP.viaLiteral",
      "DS1301 src/main.ts:122 HiddenT.viaExtends",
      "DS1301 src/main.ts:158 HiddenS.viaSatisfies",
    ]);
  });
});

describe("serialization-contract over conversions declared as accessors", () => {
  const found = treeFindings({
    "main.ts": [
      "export class Odd {",
      "  id = 1;",
      "  get toJSON(): () => number {",
      "    return () => this.id;",
      "  }",
      "  get label(): string {",
      '    return "odd";',
      "  }",
      "}",
      "console.log(JSON.stringify(new Odd()));",
      "export interface Shape {",
      "  id: number;",
      "  get toJSON(): () => number;",
      "}",
      "export const shape: Shape = {",
      "  id: 1,",
      "  get toJSON() {",
      "    return () => 2;",
      "  },",
      "};",
      "console.log(JSON.stringify(shape));",
      "",
    ].join("\n"),
  });

  it("holds back a class's toJSON getter, which JSON.stringify reads and calls", () => {
    expect(found.filter((one) => one.includes("Odd."))).toEqual(["DS1003 Odd.label"]);
  });

  it("holds back the toJSON getter of an interface a serialized value carries", () => {
    expect(found.filter((one) => one.includes("Shape."))).toEqual([]);
  });
});

/** The calls whose arguments reach a serializer through a callee the tree merges into. */
const MERGED_CALLS = [
  "class Mark {",
  "  id = 1;",
  "}",
  "console.log(new Mark());",
  "class Sent {",
  "  id = 1;",
  "}",
  "function send(value: unknown): string {",
  "  return JSON.stringify(value);",
  "}",
  "console.log(send.call(undefined, new Sent()));",
  "",
].join("\n");

/** The members `merged.ts` merges into the global `Console` and `CallableFunction`. */
const MERGED_INTERFACES = [
  "interface Console {",
  '  log(value: { id: number }, tag: "typed"): void;',
  "}",
  "interface CallableFunction {",
  '  call(this: Function, thisArg: unknown, tag: "x"): void;',
  "}",
];

describe.each([
  [
    "a declare global block of a module",
    {
      "merged.ts": [
        "export {};",
        "declare global {",
        ...MERGED_INTERFACES.map((line) => `  ${line}`),
        "}",
        "",
      ].join("\n"),
    },
  ],
  [
    "a script file's interfaces",
    {
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          strict: true,
          target: "ESNext",
          module: "NodeNext",
          moduleResolution: "nodenext",
          moduleDetection: "legacy",
          noEmit: true,
        },
        include: ["**/*.ts"],
      }),
      "merged.ts": [...MERGED_INTERFACES, ""].join("\n"),
    },
  ],
])("serialization-contract where %s merge into standard-library callees", (_form, merged) => {
  const found = treeFindings({ ...merged, "main.ts": MERGED_CALLS });

  it("reads console.log, which the call resolves to the library's signature of, as outside the analysis", () => {
    expect(found.filter((one) => one.includes("Mark."))).toEqual([]);
  });

  it("reads Function.prototype.call as a call of the function", () => {
    expect(found.filter((one) => one.includes("Sent."))).toEqual([]);
  });
});

describe("serialization-contract through the types a serialized value's walk meets", () => {
  const found = treeFindings({
    "main.ts": [
      "class Mapped {",
      "  id = 1;",
      "}",
      "function unbox<T>(boxes: { [K in keyof T]: { v: T[K] } }): T {",
      "  return Object.fromEntries(",
      "    Object.entries(boxes).map(([k, b]) => [k, (b as { v: unknown }).v]),",
      "  ) as T;",
      "}",
      "const unboxed = unbox({ held: { v: new Mapped() } });",
      "console.log(JSON.stringify(unboxed));",
      "class InFunction {",
      "  id = 1;",
      "}",
      "function local() {",
      "  class Local {",
      "    held = new InFunction();",
      "  }",
      "  return new Local();",
      "}",
      "console.log(JSON.stringify(local()));",
      "class InExpression {",
      "  id = 1;",
      "}",
      "const Anonymous = class {",
      "  held = new InExpression();",
      "};",
      "console.log(JSON.stringify(new Anonymous()));",
      "",
    ].join("\n"),
  });

  it("walks a type the checker infers through a homomorphic mapped type", () => {
    expect(found.filter((one) => one.includes("Mapped."))).toEqual([]);
  });

  it.each([
    ["a class declared in a function", "InFunction"],
    ["an anonymous class expression", "InExpression"],
  ])("walks the fields of %s, which the inventory does not hold", (_name, held) => {
    expect(found.filter((one) => one.includes(`${held}.`))).toEqual([]);
  });
});

describe("print-retained over a project whose values reach serializers", () => {
  it("prints each serialized member with the callee its value was passed to, and exits 0", async () => {
    const out = new MemoryWriter();
    const err = new MemoryWriter();

    expect(run(["print-retained", `--target=${TARGET}`], out, err, nodeHost())).toBe(0);
    expect(err.text).toBe("");
    await expect(
      out.text,
      "regenerate with `npx vitest --run -u src/serialization-contract.test.ts` and review the diff",
    ).toMatchFileSnapshot(fixture("golden", "serialization-contract.retained.txt"));
  });
});

const SINK = {
  "node_modules/@example/sink/package.json": JSON.stringify({
    name: "@example/sink",
    version: "0.0.0",
    types: "./index.d.ts",
  }),
  "node_modules/@example/sink/index.d.ts": [
    "export declare function hold(first: unknown, second: { id: number }): void;",
    "export declare function place(value: { id: number }): void;",
    "export declare function store(value: { id: number }): void;",
    "export declare function store(value: unknown, slot: number): void;",
    "",
  ].join("\n"),
};

function retainedIn(
  main: readonly string[],
  others: Readonly<Record<string, string>> = {},
): string[] {
  const root = writeProject({
    "package.json": JSON.stringify({ name: "@example/tree", private: true, type: "module" }),
    "main.ts": `${main.join("\n")}\n`,
    ...SINK,
    ...others,
  });
  try {
    const { config } = resolve({
      repository: {
        text: JSON.stringify({
          target: { kind: "application" },
          ts: { entry_files: ["main.ts"] },
        }),
        label: "deadset.json",
      },
    });
    const host = nodeHost();
    const swept = runSweep(
      openEngine({ collectTiming: false }),
      host,
      scopeForDir(host, root),
      config,
      { marked: [], mode: { production: true } },
    );
    return swept.sweep.retained
      .filter((held) => held.class === "serialization-contract")
      .map(
        (held) =>
          `${nameOf(swept, held.id)} ${String(held.site.line)}:${String(held.site.column)} ${held.detail}`,
      );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("serialization-contract over a written tree", () => {
  it(
    "holds back a class's properties, and not its toString, where a function hands it on to a serializer",
    () => {
      expect(
        retainedIn([
          'class Message { text = ""; toString(): string { return ""; } }',
          "function send(value: unknown): void { JSON.stringify(value); }",
          "send(new Message());",
        ]),
      ).toEqual(["Message.text 3:6 passed to send"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "holds back the conversion methods too where a function hands its parameter to a serializer and then out of the analysis",
    () => {
      expect(
        retainedIn([
          'class Note { text = ""; toString(): string { return ""; } }',
          "function emit(value: unknown): void { JSON.stringify(value); console.log(value); }",
          "emit(new Note());",
        ]),
      ).toEqual(["Note.text 3:6 passed to emit", "Note.toString 3:6 passed to emit"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "holds back toJSON and not toString of a class a serializer is given",
    () => {
      expect(
        retainedIn([
          'class Ticket { id = 1; toJSON(): number { return 1; } toString(): string { return ""; } }',
          "JSON.stringify(new Ticket());",
        ]),
      ).toEqual([
        "Ticket.id 2:16 passed to JSON.stringify",
        "Ticket.toJSON 2:16 passed to JSON.stringify",
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "holds back the data members and toJSON of an interface a serialized value is typed by",
    () => {
      expect(
        retainedIn([
          "interface Shape { side: number; describe(): string; toJSON(): unknown; toString(): string }",
          "declare const shape: Shape;",
          "JSON.stringify(shape);",
          "shape.side = 1;",
        ]),
      ).toEqual([
        "Shape.side 3:16 passed to JSON.stringify",
        "Shape.toJSON 3:16 passed to JSON.stringify",
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "reads `this` in an arrow function an object literal's property holds as the enclosing method's",
    () => {
      expect(
        retainedIn([
          "class Box {",
          "  size = 1;",
          "  wrap(): { run: () => string } {",
          "    return { run: () => JSON.stringify(this) };",
          "  }",
          "}",
          "new Box().wrap().run();",
        ]),
      ).toEqual(["Box.size 4:40 passed to JSON.stringify"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "binds each argument to the parameter at its position, and every one from a rest parameter's on",
    () => {
      expect(
        retainedIn([
          "class First { id = 1; }",
          "class Second { id = 1; }",
          "class Third { id = 1; }",
          "class Fourth { id = 1; }",
          "function deliver(first: object, value: unknown): void { JSON.stringify(value); }",
          "function deliverAll(first: object, ...values: unknown[]): void { JSON.stringify(values); }",
          "deliver(new First(), new Second());",
          "deliverAll(new Third(), new Fourth());",
        ]),
      ).toEqual(["Second.id 7:22 passed to deliver", "Fourth.id 8:25 passed to deliverAll"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "holds back what a typed rest parameter's type reaches, and the class an argument it types is",
    () => {
      expect(
        retainedIn([
          "interface Sized { size: number }",
          "class Crate { size = 1; }",
          "function pack(...items: Sized[]): void { JSON.stringify(items); }",
          "pack(new Crate(), { size: 2 });",
        ]),
      ).toEqual([
        "Sized.size 3:57 passed to JSON.stringify",
        "Crate.size 3:57 passed to JSON.stringify",
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "settles a function that hands its parameter on to one declared after it",
    () => {
      expect(
        retainedIn([
          "class Parcel { id = 1; }",
          "function outer(value: unknown): void { inner(value); }",
          "function inner(value: unknown): void { JSON.stringify(value); }",
          "outer(new Parcel());",
        ]),
      ).toEqual(["Parcel.id 4:7 passed to outer"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "settles a function that hands its parameter on through a conditional and an object spread",
    () => {
      expect(
        retainedIn([
          "class Branch { id = 1; }",
          "class Spread { id = 1; }",
          "function sink(value: unknown): void { JSON.stringify(value); }",
          "function branch(value: unknown, flag: boolean): void { sink(flag ? value : 0); }",
          "function spread(value: any): void { sink({ ...value }); }",
          "branch(new Branch(), true);",
          "spread(new Spread());",
        ]),
      ).toEqual(["Branch.id 6:8 passed to branch", "Spread.id 7:8 passed to spread"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "holds back what a function hands on, though another of its unknown parameters goes nowhere",
    () => {
      expect(
        retainedIn([
          "class Page { id = 1; }",
          "function report(value: unknown, note: unknown): void { JSON.stringify(value); void note; }",
          'report(new Page(), "draft");',
        ]),
      ).toEqual(["Page.id 3:8 passed to report"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "holds back what a function a namespace merges with hands on",
    () => {
      expect(
        retainedIn([
          "class Flyer { id = 1; }",
          "function announce(value: unknown): void { JSON.stringify(value); }",
          "namespace announce { export const tone = 1; }",
          "announce(new Flyer());",
        ]),
      ).toEqual(["Flyer.id 4:10 passed to announce"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "holds back nothing of a value passed to a callback the project's own function receives",
    () => {
      expect(
        retainedIn([
          "class Leaf { id = 1; }",
          "function each(visit: (value: unknown) => void): void { visit(new Leaf()); }",
          "each(() => undefined);",
        ]),
      ).toEqual([]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "holds back nothing of a value passed to a member a mapped type of the project declares",
    () => {
      expect(
        retainedIn([
          'type Api = { [K in "send"]: (value: unknown) => void };',
          "const api: Api = { send: () => undefined };",
          "class Leaf { id = 1; }",
          "api.send(new Leaf());",
        ]),
      ).toEqual([]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "holds back nothing of a value passed to a typed parameter outside the analysis, called or through call",
    () => {
      expect(
        retainedIn([
          'import { place } from "@example/sink";',
          "class Plate { id = 1; }",
          "class Dish { id = 1; }",
          "place(new Plate());",
          "place.call(undefined, new Dish());",
        ]),
      ).toEqual([]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "reads a direct call by the overload it resolves to, and a call through call by any overload",
    () => {
      expect(
        retainedIn([
          'import { store } from "@example/sink";',
          "class Shelf { id = 1; }",
          "class Bin { id = 1; }",
          "store(new Shelf());",
          "store.call(undefined, new Bin(), 1);",
        ]),
      ).toEqual(["Bin.id 5:23 passed to store"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "passes on through call every argument after the value bound to `this`",
    () => {
      expect(
        retainedIn([
          "class Alpha { id = 1; }",
          "class Beta { id = 1; }",
          "console.log.call(console, new Alpha(), new Beta());",
        ]),
      ).toEqual(["Alpha.id 3:27 passed to console.log", "Beta.id 3:40 passed to console.log"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "reads an apply argument that is no array literal as the arguments it holds",
    () => {
      expect(
        retainedIn([
          "class Gamma { id = 1; }",
          "const list: [Gamma] = [new Gamma()];",
          "JSON.stringify.apply(JSON, list);",
        ]),
      ).toEqual(["Gamma.id 3:28 passed to JSON.stringify"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "reads a bound function outside the analysis against its own parameters",
    () => {
      expect(
        retainedIn([
          'import { hold } from "@example/sink";',
          "class Head { id = 1; }",
          "class Tail { id = 1; }",
          "hold.bind(undefined, new Head())(new Tail());",
        ]),
      ).toEqual(["Head.id 4:22 passed to hold"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "reads a call of what a call through call answers as a call of that answer, not of the function",
    () => {
      expect(
        retainedIn([
          "class Lead { id = 1; }",
          "class Lag { id = 1; }",
          "function pair(first: unknown, second?: unknown): () => void {",
          "  JSON.stringify(first);",
          "  JSON.stringify(second);",
          "  return () => undefined;",
          "}",
          "pair.call(undefined, new Lead())(new Lag());",
        ]),
      ).toEqual(["Lead.id 8:22 passed to pair"]);
    },
    LOAD_TIMEOUT,
  );
});

describe("serialization-contract over a target and a consumer it imports", () => {
  it(
    "holds back nothing of a value passed to the consumer's function, which the analysis reads",
    () => {
      const compilerOptions = {
        strict: true,
        module: "NodeNext",
        moduleResolution: "nodenext",
        noEmit: true,
      };
      const top = writeProject({
        "lib/package.json": JSON.stringify({ name: "@example/lib", private: true, type: "module" }),
        "lib/tsconfig.json": JSON.stringify({ compilerOptions, include: ["*.ts"] }),
        "lib/main.ts":
          'import { hook } from "@example/app";\nclass Signal { id = 1; }\nhook(new Signal());\n',
        "app/package.json": JSON.stringify({ name: "@example/app", types: "./hooks.ts" }),
        "app/tsconfig.json": JSON.stringify({ compilerOptions, include: ["*.ts"] }),
        "app/hooks.ts": "export function hook(value: unknown): void {\n  void value;\n}\n",
      });
      try {
        mkdirSync(join(top, "lib", "node_modules", "@example"), { recursive: true });
        symlinkSync(join(top, "app"), join(top, "lib", "node_modules", "@example", "app"));
        const { config } = resolve({
          repository: {
            text: JSON.stringify({
              target: { kind: "application" },
              ts: { entry_files: ["main.ts"] },
            }),
            label: "deadset.json",
          },
        });
        const swept = runSweep(
          openEngine({ collectTiming: false }),
          nodeHost(),
          {
            target: { id: "@example/lib", path: join(top, "lib") },
            consumers: [{ id: "@example/app", path: join(top, "app") }],
          },
          config,
          { marked: [], mode: { production: true } },
        );

        expect(
          swept.sweep.retained.filter((held) => held.class === "serialization-contract"),
        ).toEqual([]);
        expect(deadMembers(swept)).toEqual(["Signal.id"]);
      } finally {
        rmSync(top, { recursive: true, force: true });
      }
    },
    LOAD_TIMEOUT,
  );
});

describe("a value a declaration holds, passed by name to a function outside the analysis", () => {
  it("has its type's data members read where a type parameter nothing constrains types the parameter, and not where a constraint names the type or the result hands the value back", () => {
    expect(
      treeFindings({
        "lib.d.ts": [
          "export declare function send<D>(url: string, data?: D): Promise<void>;",
          "export declare function keyed<D extends { id: string }>(data: D): void;",
          "export declare function echo<D>(data: D): Promise<Awaited<D>>;",
          "",
        ].join("\n"),
        "main.ts": [
          'import { echo, keyed, send } from "./lib.js";',
          "type Payload = { title: string; body: string };",
          "type Keyed = { id: string; note: string };",
          'const payload: Payload = { title: "t", body: "b" };',
          'const record: Keyed = { id: "i", note: "n" };',
          'await send("u", payload);',
          "keyed(record);",
          "type Echoed = { kept: string; dropped: string };",
          'const echoed: Echoed = { kept: "k", dropped: "d" };',
          "console.log((await echo(echoed)).kept);",
          "",
        ].join("\n"),
      }).filter((one) => one.startsWith("DS1301")),
    ).toEqual(["DS1301 Keyed.id", "DS1301 Keyed.note", "DS1301 Echoed.dropped"]);
  });
});

describe("a parameter that keeps no member name and that its function enumerates", () => {
  it(
    "holds back the properties of each value passed to it, through a parameter that hands it on",
    () => {
      expect(
        retainedIn([
          "interface Args { port?: number; seed?: string }",
          "function command(args: { [key: string]: unknown }): string[] {",
          "  return Object.keys(args).map((key) => `--${key}=${String(args[key])}`);",
          "}",
          "function start(args: any): string[] { return command(args); }",
          "const args: Args = {};",
          "args.port = 1;",
          'args.seed = "s";',
          "console.log(start(args));",
        ]),
      ).toEqual(["Args.port 9:19 passed to start", "Args.seed 9:19 passed to start"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "holds back the properties of each value passed to a parameter typed by named properties and a string index signature",
    () => {
      expect(
        retainedIn([
          "interface Args { port?: number; seed?: string }",
          "function command(args: { [key: string]: unknown }): string[] {",
          "  return Object.keys(args).map((key) => `--${key}=${String(args[key])}`);",
          "}",
          "function start(args: { port?: number; [key: string]: unknown }): string[] {",
          "  return command(args);",
          "}",
          "const args: Args = {};",
          "args.port = 1;",
          'args.seed = "s";',
          "console.log(start(args));",
        ]),
      ).toEqual(["Args.seed 11:19 passed to start"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "holds back the properties a callback the function passes on enumerates, and none a nested function nothing calls enumerates",
    () => {
      expect(
        retainedIn([
          "interface Args { port?: number; seed?: string }",
          "interface Other { kept?: number; spare?: string }",
          "function command(args: { [key: string]: unknown }): string[] {",
          "  return [1].flatMap(() => Object.keys(args));",
          "}",
          "function never(other: { [key: string]: unknown }): number {",
          "  function unused(): string[] { return Object.keys(other); }",
          "  return 1;",
          "}",
          'const args: Args = { port: 1, seed: "s" };',
          "const other: Other = {};",
          "console.log(command(args), never(other));",
        ]),
      ).toEqual(["Args.port 12:21 passed to command", "Args.seed 12:21 passed to command"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "holds back nothing where an `Object` of the project's own takes the parameter",
    () => {
      expect(
        retainedIn([
          "interface Args { port?: number; seed?: string }",
          "const Object = { keys: (_: unknown): string[] => [] };",
          "function command(args: { [key: string]: unknown }): string[] {",
          "  return Object.keys(args);",
          "}",
          "const args: Args = {};",
          "console.log(command(args));",
        ]),
      ).toEqual([]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "holds back nothing where the function reads its parameter by no enumeration",
    () => {
      expect(
        retainedIn([
          "interface Args { port?: number; seed?: string }",
          "function command(args: { [key: string]: unknown }): unknown {",
          '  return args["port"];',
          "}",
          "const args: Args = {};",
          "args.port = 1;",
          "console.log(command(args));",
        ]),
      ).toEqual([]);
    },
    LOAD_TIMEOUT,
  );
});

describe("a value a generic function serializes through its type parameter", () => {
  it(
    "holds back the type each call passes for the parameter, through the generic functions that hand it on",
    () => {
      expect(
        retainedIn([
          "interface Payload { kept: string; disabled?: boolean }",
          "interface Other { spare?: string }",
          "interface Options<T> { method: string; body?: T | string }",
          "class Client {",
          "  post<ReqT>(path: string, json?: ReqT): string {",
          "    const options: Options<ReqT> = Object.assign({ method: path }, { body: json });",
          "    return this.request<ReqT>(options);",
          "  }",
          "  request<ReqT>(options: Options<ReqT>): string {",
          "    return this.send(options);",
          "  }",
          "  private send<ReqT>(options: Options<ReqT>): string {",
          '    return typeof options.body === "string" ? options.body : JSON.stringify(options.body);',
          "  }",
          "}",
          "function unrelated<T>(value: T): T { return value; }",
          'const payload: Payload = { kept: "k" };',
          "payload.disabled = true;",
          "const other: Other = {};",
          "unrelated(other);",
          'console.log(new Client().post("/p", payload));',
        ]),
      ).toEqual([
        "Payload.kept 21:13 passed to JSON.stringify through the type parameter ReqT",
        "Payload.disabled 21:13 passed to JSON.stringify through the type parameter ReqT",
      ]);
    },
    LOAD_TIMEOUT,
  );
  it.each([
    ["through call", "box.call(undefined, value)"],
    ["through apply", "box.apply(undefined, [value])"],
    ["through a called bind", "box.bind(undefined)(value)"],
    ["through bind with the argument bound", "box.bind(undefined, value)()"],
    ["through a variable that copies it", "copied(value)"],
    ["through call on a variable that copies it", "copied.call(undefined, value)"],
  ])(
    "holds back the type a call %s passes for the parameter",
    (_form, call) => {
      expect(
        retainedIn([
          "class Parcel { id = 1; }",
          "function box<T>(value: T): string { return JSON.stringify(value); }",
          "const copied = box;",
          `function outer<T>(value: T): string { return ${call}; }`,
          "console.log(outer(new Parcel()));",
        ]),
      ).toEqual(["Parcel.id 5:13 passed to JSON.stringify through the type parameter T"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "holds back the type a call passes through an import that renames the function",
    () => {
      expect(
        retainedIn(
          [
            'import { box as packed } from "./box.ts";',
            "class Parcel { id = 1; }",
            "function outer<T>(value: T): string { return packed(value); }",
            "console.log(outer(new Parcel()));",
          ],
          {
            "box.ts":
              "export function box<T>(value: T): string { return JSON.stringify(value); }\n",
          },
        ),
      ).toEqual(["Parcel.id 4:13 passed to JSON.stringify through the type parameter T"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "holds back nothing of a type a same-named function of another scope is called with",
    () => {
      expect(
        retainedIn([
          "class Parcel { id = 1; }",
          "class Other { id = 1; }",
          "function box<T>(value: T): string { return JSON.stringify(value); }",
          "function outer<T>(value: T): string { return box(value); }",
          "function elsewhere(): void { const box = (value: Other): Other => value; box(new Other()); }",
          "elsewhere();",
          "console.log(outer(new Parcel()));",
        ]),
      ).toEqual(["Parcel.id 7:13 passed to JSON.stringify through the type parameter T"]);
    },
    LOAD_TIMEOUT,
  );

  it.each([
    [
      "spreads a tuple",
      "function outer<T>(...value: [T]): string { return box.call(undefined, ...value); }",
    ],
    [
      "spreads an array",
      "function outer<T>(...value: T[]): string { return box.call(undefined, ...value); }",
    ],
    [
      "applies a list that is no literal",
      "function outer<T>(value: T): string { const list = [value]; return box.apply(undefined, list); }",
    ],
    [
      "applies a tuple that is no literal",
      "function outer<T>(value: T): string { const list: [T] = [value]; return box.apply(undefined, list); }",
    ],
  ])(
    "holds back the type an indirect call binds where it %s",
    (_form, outer) => {
      expect(
        retainedIn([
          "class Parcel { id = 1; }",
          "function box<T>(value: T): string { return JSON.stringify(value); }",
          outer,
          "console.log(outer(new Parcel()));",
        ]),
      ).toEqual(["Parcel.id 4:13 passed to JSON.stringify through the type parameter T"]);
    },
    LOAD_TIMEOUT,
  );

  it.each([
    ["directly", "hold(new Parcel());"],
    ["through call", "hold.call(undefined, new Parcel());"],
  ])(
    "holds back the conversions of a value an outside generic takes unconstrained, called %s",
    (_form, call) => {
      expect(
        retainedIn(
          [
            'import { hold } from "./outside.ts";',
            'class Parcel { id = 1; toString(): string { return ""; } }',
            call,
          ],
          { "outside.ts": "export declare function hold<T>(value: T): void;\n" },
        )
          .map((line) => line.replace(/ \d+:\d+ /u, " "))
          .sort(),
      ).toEqual(["Parcel.id passed to hold", "Parcel.toString passed to hold"]);
    },
    LOAD_TIMEOUT,
  );

  it.each([
    [
      "an outside generic, after a tuple spread fills its first place",
      "declare function hold<T>(label: string, value: T): void;",
      "hold.call(undefined, ...pair);",
      "hold",
    ],
    [
      "an outside unknown parameter, after a tuple spread, called directly",
      "declare function hold(a: string, b: string, c: unknown): void;",
      "hold(...two, new Parcel());",
      "hold",
    ],
    [
      "an outside unknown parameter, after a tuple spread, through call",
      "declare function hold(a: string, b: string, c: unknown): void;",
      "hold.call(undefined, ...two, new Parcel());",
      "hold",
    ],
    [
      "an outside generic, through apply of an array",
      "declare function hold<T>(label: string, ...values: T[]): void;",
      'hold.apply(undefined, ["a", ...parcels]);',
      "hold",
    ],
  ])(
    "holds back the conversions of a value passed to %s",
    (_form, declaration, call, callee) => {
      expect(
        retainedIn(
          [
            'import { hold } from "./outside.ts";',
            'class Parcel { id = 1; toString(): string { return ""; } }',
            'const pair: [string, Parcel] = ["x", new Parcel()];',
            'const two: [string, string] = ["a", "b"];',
            "const parcels: Parcel[] = [];",
            call,
          ],
          { "outside.ts": `export ${declaration}\n` },
        )
          .map((line) => line.replace(/ \d+:\d+ /u, " "))
          .sort(),
      ).toEqual([`Parcel.id passed to ${callee}`, `Parcel.toString passed to ${callee}`]);
    },
    LOAD_TIMEOUT,
  );

  it.each([
    ["called directly", 'emit("x", new Parcel());'],
    ["through call", 'emit.call(undefined, "x", new Parcel());'],
  ])(
    "holds back the type a later element of a rest tuple binds, %s",
    (_form, call) => {
      expect(
        retainedIn([
          'class Parcel { id = 1; toString(): string { return ""; } }',
          "function emit<T>(...value: [string, T]): string { return JSON.stringify(value[1]); }",
          call,
        ]).map((line) => line.replace(/ \d+:\d+ /u, " ")),
      ).toEqual(["Parcel.id passed to JSON.stringify through the type parameter T"]);
    },
    LOAD_TIMEOUT,
  );

  it.each([
    [
      "spreads a rest tuple into later places",
      "function outer<T>(...value: [string, T]): string { return box.call(undefined, ...value); }",
      'console.log(outer("x", new Parcel()));',
    ],
    [
      "passes it past the callee's parameter count, before an array spread",
      'function outer<T>(value: T): string { const extras: string[] = []; return rest.call(undefined, "a", "b", value, ...extras); }',
      "console.log(outer(new Parcel()));",
    ],
  ])(
    "holds back the type a forwarding call binds where it %s",
    (_form, outer, call) => {
      expect(
        retainedIn([
          "class Parcel { id = 1; }",
          "function box<T>(label: string, value: T): string { return JSON.stringify(value); }",
          "function rest<T>(first: string, ...values: T[]): string { return JSON.stringify(values); }",
          outer,
          call,
        ]).map((line) => line.replace(/ \d+:\d+ /u, " ")),
      ).toEqual(["Parcel.id passed to JSON.stringify through the type parameter T"]);
    },
    LOAD_TIMEOUT,
  );

  it.each([
    ["a rest tuple's unknown element", "[string, unknown]"],
    ["an unknown element of a union rest", "[string, unknown] | [string]"],
    ["a union rest's array of unknown", "[string] | unknown[]"],
    ["an unknown element of a branded rest", "[string, unknown] & { readonly __args?: never }"],
    ["an unknown element of a rest intersected with an array", "[string, unknown] & unknown[]"],
  ])(
    "holds back a value passed to %s of a function that hands it on",
    (_form, rest) => {
      expect(
        retainedIn([
          'class Parcel { id = 1; toString(): string { return ""; } }',
          `function send(...value: ${rest}): void { JSON.stringify(value); }`,
          'send("x", new Parcel());',
        ]),
      ).toEqual(["Parcel.id 3:11 passed to send"]);
    },
    LOAD_TIMEOUT,
  );

  const parameterRest = "<A extends unknown[]>(...args: A)";
  const tupleRest = "<A extends [string, unknown]>(...args: A)";
  const unionRest = "(...args: [string, unknown] | [number])";
  const tupleOrArray = "(...args: [string, unknown] | number[])";
  const branded = "(...args: [name: string, value: unknown] & { readonly __args?: never })";
  const withArray = "(...args: [string, unknown] & unknown[])";
  const mapped = "<T extends unknown[]>(...args: { [K in keyof T]: T[K] | undefined })";
  it.each([
    ["a type parameter, called directly", parameterRest, 'emit("a", new Parcel());'],
    ["a type parameter, through call", parameterRest, 'emit.call(undefined, "a", new Parcel());'],
    [
      "a type parameter, through apply",
      parameterRest,
      'emit.apply(undefined, ["a", new Parcel()]);',
    ],
    ["a type parameter of a tuple, called directly", tupleRest, 'emit("a", new Parcel());'],
    [
      "a type parameter of a tuple, through call",
      tupleRest,
      'emit.call(undefined, "a", new Parcel());',
    ],
    ["a union of tuples, called directly", unionRest, 'emit("a", new Parcel());'],
    ["a union of tuples, through call", unionRest, 'emit.call(undefined, "a", new Parcel());'],
    ["a union of a tuple and an array, called directly", tupleOrArray, 'emit("a", new Parcel());'],
    [
      "a union of a tuple and an array, through call",
      tupleOrArray,
      'emit.call(undefined, "a", new Parcel());',
    ],
    [
      "a union of a tuple and an array, through apply",
      tupleOrArray,
      'emit.apply(undefined, ["a", new Parcel()]);',
    ],
    [
      "a union of tuples none of which covers the place",
      "(...args: [string] | [number])",
      'emit("a", new Parcel());',
    ],
    ["a branded tuple, called directly", branded, 'emit("a", new Parcel());'],
    ["a branded tuple, through call", branded, 'emit.call(undefined, "a", new Parcel());'],
    ["a branded tuple, through apply", branded, 'emit.apply(undefined, ["a", new Parcel()]);'],
    ["a tuple and an array intersected, called directly", withArray, 'emit("a", new Parcel());'],
    [
      "a tuple and an array intersected, through call",
      withArray,
      'emit.call(undefined, "a", new Parcel());',
    ],
    [
      "a tuple and an array intersected, through apply",
      withArray,
      'emit.apply(undefined, ["a", new Parcel()]);',
    ],
    ["a mapped type over a type parameter, called directly", mapped, 'emit("a", new Parcel());'],
    [
      "a mapped type over a type parameter, through call",
      mapped,
      'emit.call(undefined, "a", new Parcel());',
    ],
  ])(
    "holds back the conversions of a value passed to an outside rest typed by %s",
    (_form, signature, call) => {
      expect(
        retainedIn(
          [
            'import { emit } from "./outside.ts";',
            'class Parcel { id = 1; toString(): string { return ""; } }',
            call,
          ],
          { "outside.ts": `export declare function emit${signature}: void;\n` },
        )
          .map((line) => line.replace(/ \d+:\d+ /u, " "))
          .sort(),
      ).toEqual(["Parcel.id passed to emit", "Parcel.toString passed to emit"]);
    },
    LOAD_TIMEOUT,
  );

  const listedArgs = "interface Args extends Array<unknown> { 0: string }";
  const readonlyArgs = "interface Args extends ReadonlyArray<unknown> { readonly 0: string }";
  it.each([
    ["an interface over an array, through apply", listedArgs, "emit.apply(undefined, list);"],
    ["an interface over an array, through a spread", listedArgs, "emit(...list);"],
    [
      "an interface over an array, through call with a spread",
      listedArgs,
      "emit.call(undefined, ...list);",
    ],
    ["an interface over a readonly array, through a spread", readonlyArgs, "emit(...list);"],
    ["a readonly array, through a spread", "type Args = readonly unknown[];", "emit(...list);"],
  ])(
    "holds back the conversions of a value an open list passes to an outside rest typed by %s",
    (_form, args, call) => {
      expect(
        retainedIn(
          [
            'import { emit, type Args } from "./outside.ts";',
            'class Parcel { id = 1; toString(): string { return ""; } }',
            'const list: Args = ["a", new Parcel()];',
            call,
          ],
          { "outside.ts": `export ${args}\nexport declare function emit(...args: Args): void;\n` },
        )
          .map((line) => line.replace(/ \d+:\d+ /u, " "))
          .sort(),
      ).toEqual(["Parcel.id passed to emit", "Parcel.toString passed to emit"]);
    },
    LOAD_TIMEOUT,
  );

  it.each([
    ["Readonly of a type parameter, called directly", "<T>(x: Readonly<T>)", "emit(new Parcel());"],
    ["Partial of a type parameter, called directly", "<T>(x: Partial<T>)", "emit(new Parcel());"],
    [
      "a written mapped type over a type parameter, called directly",
      "<T>(x: { [K in keyof T]: T[K] })",
      "emit(new Parcel());",
    ],
    [
      "Readonly of a type parameter, through call",
      "<T>(x: Readonly<T>)",
      "emit.call(undefined, new Parcel());",
    ],
    [
      "Readonly of a type parameter, through apply",
      "<T>(x: Readonly<T>)",
      "emit.apply(undefined, [new Parcel()]);",
    ],
    [
      "a mapped type over a type parameter its keys are constrained to, called directly",
      "<T, K extends keyof T>(x: Pick<T, K>)",
      "emit(new Parcel());",
    ],
    [
      "Omit of a type parameter, called directly",
      "<T, K extends keyof T>(x: Omit<T, K>)",
      "emit(new Parcel());",
    ],
    [
      "Omit of a type parameter, through call",
      "<T, K extends keyof T>(x: Omit<T, K>)",
      "emit.call(undefined, new Parcel());",
    ],
    [
      "Omit of a type parameter and a literal key, through call",
      "<T>(x: Omit<T, never>)",
      "emit.call(undefined, new Parcel());",
    ],
    [
      "a written mapped type over the keys of a type parameter but one, called directly",
      '<T>(x: { [P in Exclude<keyof T, "x">]: T[P] })',
      "emit(new Parcel());",
    ],
    [
      "a mapped type over a type parameter that remaps its keys, through bind",
      "<T>(x: { [K in keyof T as `get${string & K}`]: () => T[K] })",
      "emit.bind(undefined, new Parcel())();",
    ],
  ])(
    "holds back the conversions of a value passed to an outside parameter typed by %s",
    (_form, signature, call) => {
      expect(
        retainedIn(
          [
            'import { emit } from "./outside.ts";',
            'class Parcel { id = 1; toString(): string { return ""; } }',
            call,
          ],
          { "outside.ts": `export declare function emit${signature}: void;\n` },
        )
          .map((line) => line.replace(/ \d+:\d+ /u, " "))
          .sort(),
      ).toEqual(["Parcel.id passed to emit", "Parcel.toString passed to emit"]);
    },
    LOAD_TIMEOUT,
  );

  it.each([
    ["Readonly of a type parameter", "<T>(x: Readonly<T>): T"],
    ["Omit of a type parameter", "<T, K extends keyof T>(x: Omit<T, K>): T"],
    [
      "a written mapped type over a type parameter",
      "<T>(x: { [K in keyof T]: T[K] }): { [K in keyof T]: T[K] }",
    ],
    ["Readonly of a type parameter", "<T>(x: Readonly<T>): { [K in keyof T]: T[K] }"],
  ])(
    "holds back the conversions of a value passed to an outside parameter typed by %s, whatever the result names (%s)",
    (_form, signature) => {
      expect(
        retainedIn(
          [
            'import { emit } from "./outside.ts";',
            'import { Parcel } from "./parcel.ts";',
            "console.log(emit(new Parcel()));",
          ],
          {
            "parcel.ts": 'export class Parcel { id = 1; toString(): string { return ""; } }\n',
            "outside.ts": `import type { Parcel } from "./parcel.ts";\nexport declare function emit${signature};\n`,
          },
        )
          .map((line) => line.replace(/ \d+:\d+ /u, " "))
          .filter((line) => line.includes("passed to emit"))
          .sort(),
      ).toEqual(["Parcel.id passed to emit", "Parcel.toString passed to emit"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "holds back the private members of a class whose mapped copy a result hands to JSON.stringify",
    () => {
      expect(
        retainedIn(
          [
            'import { emit } from "./outside.ts";',
            "class Parcel { private secret = 1; id = 2; }",
            "export const out = JSON.stringify(emit(new Parcel()));",
          ],
          { "outside.ts": "export declare function emit<T>(x: Readonly<T>): T;\n" },
        )
          .map((line) => line.replace(/ \d+:\d+ /u, " "))
          .filter((line) => line.startsWith("Parcel.secret")),
      ).toEqual(["Parcel.secret passed to emit"]);
    },
    LOAD_TIMEOUT,
  );

  it.each([
    ["a type parameter the result names", "<T>(x: T): T"],
    [
      "Readonly of a type parameter a constraint names the type of",
      "<T extends Parcel>(x: Readonly<T>): void",
    ],
  ])(
    "holds back nothing of a class passed to an outside parameter typed by %s",
    (_form, signature) => {
      expect(
        retainedIn(
          [
            'import { emit } from "./outside.ts";',
            'import { Parcel } from "./parcel.ts";',
            "console.log(emit(new Parcel()));",
          ],
          {
            "parcel.ts": 'export class Parcel { id = 1; toString(): string { return ""; } }\n',
            "outside.ts": `import type { Parcel } from "./parcel.ts";\nexport declare function emit${signature};\n`,
          },
        ).filter((line) => line.includes("passed to emit")),
      ).toEqual([]);
    },
    LOAD_TIMEOUT,
  );

  it.each([
    ["called directly", "emit(...parcels).length;"],
    ["through call", "emit.call(undefined, ...parcels).length;"],
    ["through apply", "emit.apply(undefined, parcels).length;"],
  ])(
    "holds back nothing of a class an open spread passes to an outside rest typed by a type parameter the result names, %s",
    (_form, call) => {
      expect(
        retainedIn(
          [
            'import { emit } from "./outside.ts";',
            'class Parcel { id = 1; toString(): string { return ""; } }',
            "const parcels: Parcel[] = [new Parcel()];",
            call,
          ],
          {
            "outside.ts": "export declare function emit<A extends unknown[]>(...args: A): A;\n",
          },
        ),
      ).toEqual([]);
    },
    LOAD_TIMEOUT,
  );

  it.each([
    ["a type parameter", "T"],
    ["Readonly of a type parameter", "Readonly<T>"],
    ["Omit of a type parameter", "Omit<T, never>"],
    [
      "a written mapped type over the keys of a type parameter but one",
      '{ [P in Exclude<keyof T, "x">]: T[P] }',
    ],
  ])(
    "holds back the type a call binds to a parameter typed by %s that its function serializes",
    (_form, type) => {
      expect(
        retainedIn([
          "class Parcel { id = 1; }",
          `function emit<T>(value: ${type}): string { return JSON.stringify(value); }`,
          "console.log(emit(new Parcel()));",
        ]).map((line) => line.replace(/ \d+:\d+ /u, " ")),
      ).toEqual(["Parcel.id passed to JSON.stringify through the type parameter T"]);
    },
    LOAD_TIMEOUT,
  );

  it.each([
    ["called directly", "console.log(emit(...parcels));"],
    ["through call", "console.log(emit.call(undefined, ...parcels));"],
  ])(
    "holds back the type an open spread binds to a rest typed by a type parameter it serializes, %s",
    (_form, call) => {
      expect(
        retainedIn([
          "class Parcel { id = 1; }",
          "function emit<A extends unknown[]>(...args: A): string { return JSON.stringify(args); }",
          "const parcels: Parcel[] = [new Parcel()];",
          call,
        ]).map((line) => line.replace(/ \d+:\d+ /u, " ")),
      ).toEqual(["Parcel.id passed to JSON.stringify through the type parameter A"]);
    },
    LOAD_TIMEOUT,
  );

  it.each([
    ["called directly", "emit(new Parcel(), 1);"],
    ["through call", "emit.call(undefined, new Parcel(), 1);"],
    ["through apply", "emit.apply(undefined, [new Parcel(), 1]);"],
  ])(
    "holds back nothing of a class at a place an outside union rest types with it, %s",
    (_form, call) => {
      expect(
        retainedIn([
          'class Parcel { id = 1; toString(): string { return ""; } }',
          "declare function emit(...args: [Parcel, unknown] | [Parcel]): void;",
          call,
        ]),
      ).toEqual([]);
    },
    LOAD_TIMEOUT,
  );

  it.each([
    ["a union of tuples, through call", "(...args: [string] | [number])", "call"],
    ["a union of tuples, through apply", "(...args: [string] | [number])", "apply"],
    ["a tuple, through call", "(...args: [string])", "call"],
    ["a fixed parameter, through call", "(a: string)", "call"],
  ])(
    "holds back nothing of a class an outside overload types beside a shorter one with %s",
    (_form, shorter, method) => {
      expect(
        retainedIn([
          'class Parcel { id = 1; toString(): string { return ""; } }',
          `declare function emit${shorter}: void;`,
          "declare function emit(a: string, b: Parcel): void;",
          method === "call"
            ? 'emit.call(undefined, "a", new Parcel());'
            : 'emit.apply(undefined, ["a", new Parcel()]);',
        ]),
      ).toEqual([]);
    },
    LOAD_TIMEOUT,
  );

  it.each([
    ["called directly", 'console.log(emit("a", new Parcel()));'],
    ["through call", 'console.log(emit.call(undefined, "a", new Parcel()));'],
  ])(
    "holds back the type a call binds to a rest typed by a type parameter it serializes, %s",
    (_form, call) => {
      expect(
        retainedIn([
          "class Parcel { id = 1; }",
          "function emit<A extends unknown[]>(...args: A): string { return JSON.stringify(args); }",
          call,
        ]).map((line) => line.replace(/ \d+:\d+ /u, " ")),
      ).toEqual(["Parcel.id passed to JSON.stringify through the type parameter A"]);
    },
    LOAD_TIMEOUT,
  );

  it.each([
    [
      "a function that serializes the other place",
      "function hold(p: Parcel, v: unknown): string { return String(p instanceof Parcel) + JSON.stringify(v); }",
      "console.log(hold(...pair));",
    ],
    [
      "a function that serializes the other place, through call",
      "function hold(p: Parcel, v: unknown): string { return String(p instanceof Parcel) + JSON.stringify(v); }",
      "console.log(hold.call(undefined, ...pair));",
    ],
    [
      "an outside function whose other place is unknown",
      "declare function hold(p: Parcel, v: unknown): void;",
      "hold(...pair);",
    ],
    [
      "an outside generic whose other place is unconstrained",
      "declare function hold<T>(p: Parcel, v: T): void;",
      "hold(...pair);",
    ],
  ])(
    "holds back nothing of a class a fixed tuple spread puts at a place of %s",
    (_form, declaration, call) => {
      expect(
        retainedIn([
          "class Parcel { id = 1; }",
          declaration,
          'const pair: [Parcel, string] = [new Parcel(), "s"];',
          call,
        ]),
      ).toEqual([]);
    },
    LOAD_TIMEOUT,
  );

  it.each([
    [
      "a function of the project",
      "function send(v: unknown, label: string): string { return label + JSON.stringify(v); }",
      "console.log(send(...pair));",
      ["Parcel.id passed to send"],
    ],
    [
      "an outside function",
      "declare function send(v: unknown, label: string): void;",
      "send(...pair);",
      ["Parcel.id passed to send", "Parcel.toString passed to send"],
    ],
  ])(
    "holds back the class a fixed tuple spread puts at the serialized place of %s",
    (_form, declaration, call, expected) => {
      expect(
        retainedIn([
          'class Parcel { id = 1; toString(): string { return ""; } }',
          declaration,
          'const pair: [Parcel, string] = [new Parcel(), "s"];',
          call,
        ])
          .map((line) => line.replace(/ \d+:\d+ /u, " "))
          .sort(),
      ).toEqual(expected);
    },
    LOAD_TIMEOUT,
  );

  it.each([
    ["logged, then serialized", "console.log(value); return JSON.stringify(value);"],
    [
      "serialized, then logged",
      "const text = JSON.stringify(value); console.log(value); return text;",
    ],
  ])(
    "holds back what each destination of one type parameter holds back, %s",
    (_order, body) => {
      expect(
        retainedIn([
          'class Parcel { id = 1; toJSON(): number { return this.id; } toString(): string { return ""; } }',
          `function emit<T>(value: T): string { ${body} }`,
          "console.log(emit(new Parcel()));",
        ]).sort(),
      ).toEqual([
        "Parcel.id 3:13 passed to JSON.stringify through the type parameter T",
        "Parcel.id 3:13 passed to console.log through the type parameter T",
        "Parcel.toJSON 3:13 passed to JSON.stringify through the type parameter T",
        "Parcel.toJSON 3:13 passed to console.log through the type parameter T",
        "Parcel.toString 3:13 passed to console.log through the type parameter T",
      ]);
    },
    LOAD_TIMEOUT,
  );
});

/** Each finding about a member, as `code name confidence`, of one application run over `main`. */
function memberFindings(main: readonly string[], declarations = ""): string[] {
  const root = writeProject({
    "package.json": JSON.stringify({ name: "@example/tree", private: true, type: "module" }),
    "deadset.json": JSON.stringify({
      target: { kind: "application" },
      ts: { entry_files: ["main.ts"] },
    }),
    "main.ts": `${main.join("\n")}\n`,
    ...(declarations === "" ? {} : { "outside.d.ts": declarations }),
  });
  const report = join(root, "report.json");
  try {
    run(
      ["analyze", "--target=.", "--min-confidence=possible", `--report=${report}`],
      new MemoryWriter(),
      new MemoryWriter(),
      { ...nodeHost(), workingDirectory: () => root },
    );
    const found = JSON.parse(readFileSync(report, "utf8")) as {
      findings: { code: string; symbol: { name: string }; confidence: string }[];
    };
    return found.findings
      .filter((one) => one.symbol.name.includes("."))
      .map((one) => `${one.code} ${one.symbol.name} ${one.confidence}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("a member of a type the program sends or only receives", () => {
  it(
    "is live on a sent type where production writes it, and dead where nothing writes or reads it",
    () => {
      expect(
        memberFindings([
          "interface Target { uri: string; body?: string; method: string }",
          "class Stamp { at = 1; unset?: number; set?: number; constructor() { this.set = 2; } }",
          'const target: Target = { uri: "u", method: "GET" };',
          "console.log(JSON.stringify(target), JSON.stringify(new Stamp()));",
        ]),
      ).toEqual(["DS1003 Target.body certain", "DS1003 Stamp.unset certain"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is written by a literal whose type is inferred, where a value of that type reaches the member's type",
    () => {
      expect(
        memberFindings([
          "interface Sent { id: number; label: string }",
          "interface Kept { id: number; label: string }",
          "function sent(ids: readonly number[]): readonly Sent[] {",
          '  return ids.map((id) => ({ id, label: "l" }));',
          "}",
          "function kept(ids: readonly number[]): readonly Kept[] {",
          '  return ids.map((id) => ({ id, label: "l" }));',
          "}",
          "console.log(JSON.stringify(sent([1])), kept([2]).length);",
        ]),
      ).toEqual(["DS1301 Kept.id certain", "DS1301 Kept.label certain"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is dead where the program only decodes into it and never reads it: certain through JSON.parse, possible through a generic outside the analysis that fills its type parameter",
    () => {
      expect(
        memberFindings(
          [
            'import { fetchJson, identity } from "./outside.js";',
            "interface Parsed { used: string; unread: string }",
            "interface Fetched { used: string; unread: string }",
            "interface Passed { used: string; unread: string }",
            'const parsed = JSON.parse(process.argv[2] ?? "{}") as Parsed;',
            'const fetched = await fetchJson<Fetched>("u");',
            'const passed = identity<Passed>(JSON.parse("{}") as Passed);',
            "console.log(parsed.used, fetched.used, passed.used);",
          ],
          [
            "export declare function fetchJson<T>(url: string): Promise<T>;",
            "export declare function identity<T>(value: T): T;",
            "",
          ].join("\n"),
        ),
      ).toEqual([
        "DS1003 Parsed.unread certain",
        "DS1003 Fetched.unread possible",
        "DS1003 Passed.unread certain",
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is written by a decode the program sends on: JSON.parse asserted or annotated, or a generic outside the analysis that fills its type parameter",
    () => {
      expect(
        memberFindings(
          [
            'import { fetchJson } from "./outside.js";',
            "interface Relayed { kind: string; seq: number }",
            "interface Saved { name: string; spare: string }",
            "interface Fetched { kind: string; seq: number }",
            "interface Built { ready: boolean }",
            'const relayed = JSON.parse(process.argv[2] ?? "{}") as Relayed;',
            'const saved: Saved = JSON.parse("{}");',
            'saved.name = "renamed";',
            'const fetched = await fetchJson<Fetched>("u");',
            "const built = {} as Built;",
            "console.log(JSON.stringify(relayed), JSON.stringify(saved));",
            "console.log(JSON.stringify(fetched), JSON.stringify(built));",
          ],
          ["export declare function fetchJson<T>(url: string): Promise<T>;", ""].join("\n"),
        ),
      ).toEqual(["DS1003 Built.ready certain"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is written by an untyped value read as its type where it is written, and by a callback's result a call hands on",
    () => {
      expect(
        memberFindings(
          [
            'import { event, getJson } from "./outside.js";',
            "interface Payload { kind: string; seq: number }",
            "interface Saved { name: string; spare: number }",
            "interface Line { id: string }",
            "interface Listed { tag: string }",
            "interface Message { body: string }",
            "interface Posted { at: string }",
            "interface Indexed { slot: string }",
            "interface Built { ready: boolean }",
            "function load(text: string): Saved {",
            "  return JSON.parse(text);",
            "}",
            "const payload = (await getJson()) as Payload;",
            "let line: Line;",
            'line = JSON.parse("{}");',
            'const listed: Listed[] = ["{}"].map((one) => JSON.parse(one));',
            "const message = event.data as Message;",
            "const posted: Posted = event.raw;",
            'const indexed: Indexed = event["raw"];',
            "const built = {} as Built;",
            'console.log(JSON.stringify(load("{}")), JSON.stringify(payload));',
            "console.log(JSON.stringify(line), JSON.stringify(listed));",
            "console.log(JSON.stringify(message), JSON.stringify(built));",
            "console.log(JSON.stringify(posted), JSON.stringify(indexed));",
          ],
          [
            "export declare function getJson(): Promise<any>;",
            "export declare const event: { data: unknown; raw: any };",
            "",
          ].join("\n"),
        ),
      ).toEqual(["DS1003 Built.ready certain"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is written by a spread or an Object.assign copying a value whose type has the member",
    () => {
      expect(
        memberFindings([
          "interface Base { kind: string; extra: string }",
          "interface Spread { kind: string; level: number }",
          "interface Assigned { label: string; note: string }",
          'const base: Base = { kind: "a", extra: "b" };',
          "const spread: Spread = { ...base, level: 1 };",
          "const assigned = {} as Assigned;",
          'Object.assign(assigned, { label: "x" });',
          "console.log(JSON.stringify(spread), JSON.stringify(assigned), base.extra);",
        ]),
      ).toEqual(["DS1003 Assigned.note certain"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is not written by a JSON.parse result a satisfies check names the type of",
    () => {
      expect(
        memberFindings([
          "interface Payload { kept: string; ghost: string }",
          "interface Stored { kept: string; ghost: string }",
          'const checked = JSON.parse("{}") satisfies Payload;',
          'const stored: Stored = JSON.parse("{}") satisfies Stored;',
          'const sent = { kept: "x" } as Payload;',
          "console.log(checked, JSON.stringify(sent), JSON.stringify(stored));",
        ]),
      ).toEqual(["DS1003 Payload.ghost certain"]);
    },
    LOAD_TIMEOUT,
  );
});

describe("a serialized value whose argument type is not concrete", () => {
  const parcel = "class Parcel { private secret = 1; id = 2; }";
  it.each([
    [
      "a library's mapped result",
      [parcel, "export const out = JSON.stringify(Object.freeze(new Parcel()));"],
      "",
    ],
    [
      "an outside result inferred through a mapped place over a type parameter a constraint names",
      [
        parcel,
        'import { emit } from "./outside.js";',
        "export const out = JSON.stringify(emit(new Parcel()));",
      ],
      "export declare function emit<T extends object>(x: Readonly<T>): T;\n",
    ],
    [
      "an outside place typed by a mapped type whose template is an object type over a type parameter",
      [parcel, 'import { save } from "./outside.js";', "save({ box: { value: new Parcel() } });"],
      'export declare function save<T>(value: { [K in "box"]: { value: T } }): void;\n',
    ],
    [
      "a type parameter four type arguments deep",
      [
        parcel,
        "interface Box<U> { v: U }",
        "function save<T>(x: Box<Box<Box<Box<T>>>>): string { return JSON.stringify(x); }",
        "export const out = save({ v: { v: { v: { v: new Parcel() } } } });",
      ],
      "",
    ],
    [
      "a type parameter of a class",
      [
        parcel,
        "class Store<T> { save(x: T): string { return JSON.stringify(x); } }",
        "export const out = new Store<Parcel>().save(new Parcel());",
      ],
      "",
    ],
    [
      "a class's type parameter a constructor parameter property holds",
      [
        parcel,
        "class Store<T> { constructor(private readonly v: T) {} dump(): string { return JSON.stringify(this.v); } }",
        "export const out = new Store(new Parcel()).dump();",
      ],
      "",
    ],
    [
      "a variable an outside result inferred through a mapped place initializes",
      [
        parcel,
        'import { emit } from "./outside.js";',
        "const copy = emit(new Parcel());",
        "export const out = JSON.stringify(copy);",
      ],
      "export declare function emit<T extends object>(x: Readonly<T>): T;\n",
    ],
    [
      "an object type a project function returns over a type parameter",
      [
        parcel,
        "function wrap<T>(x: T): { inner: T } { return { inner: x }; }",
        "function save<T>(x: T): string { return JSON.stringify(wrap(x)); }",
        "export const out = save(new Parcel());",
      ],
      "",
    ],
    [
      "this in a class another class extends",
      [
        "class Base { base = 0; dump(): string { return JSON.stringify(this); } }",
        "class Parcel extends Base { private secret = 1; id = 2; }",
        "export const out = new Parcel().dump();",
      ],
      "",
    ],
    [
      "this in a generic class whose type argument a new expression infers",
      [
        parcel,
        "class Store<T> { constructor(readonly v: T) {} dump(): string { return JSON.stringify(this); } }",
        "export const out = new Store(new Parcel()).dump();",
      ],
      "",
    ],
    [
      "a library's generic result whose data member holds its type argument",
      [
        parcel,
        "function* make(): Generator<Parcel> { yield new Parcel(); }",
        "export const out = JSON.stringify(make().next());",
      ],
      "",
    ],
    [
      "a generic interface that instantiates itself afresh at each level",
      [
        parcel,
        "interface Chain<T> { value: T; next?: Chain<[T]> }",
        "const chain: Chain<Parcel> = { value: new Parcel() };",
        "export const out = JSON.stringify(chain);",
      ],
      "",
    ],
    [
      "a library iterable of a type parameter, walked by a loop",
      [
        parcel,
        "function saveAll<T>(xs: Iterable<T>): string[] { const out: string[] = []; for (const x of xs) { out.push(JSON.stringify(x)); } return out; }",
        "export const out = saveAll([new Parcel()]);",
      ],
      "",
    ],
    [
      "a library iterable of a type parameter, serialized whole",
      [
        parcel,
        "function save<T>(xs: Iterable<T>): string { return JSON.stringify(xs); }",
        "export const out = save([new Parcel()]);",
      ],
      "",
    ],
    [
      "a library map's value type parameter",
      [
        parcel,
        'function dump<T>(m: Map<string, T>): string { return JSON.stringify(m.get("a")); }',
        'export const out = dump(new Map([["a", new Parcel()]]));',
      ],
      "",
    ],
    [
      "a library set of a type parameter, spread",
      [
        parcel,
        "function save<T>(xs: ReadonlySet<T>): string[] { return [...xs].map((x) => JSON.stringify(x)); }",
        "export const out = save(new Set([new Parcel()]));",
      ],
      "",
    ],
    [
      "an own generic interface's method result",
      [
        parcel,
        "interface Source<T> { get(): T }",
        "function save<T>(s: Source<T>): string { return JSON.stringify(s.get()); }",
        "export const out = save({ get: () => new Parcel() });",
      ],
      "",
    ],
    [
      "a promise of a type parameter",
      [
        parcel,
        "async function save<T>(p: Promise<T>): Promise<string> { return JSON.stringify(await p); }",
        "export const out = save(Promise.resolve(new Parcel()));",
      ],
      "",
    ],
    [
      "a callback's result type parameter",
      [
        parcel,
        "function run<T>(f: () => T): string { return JSON.stringify(f()); }",
        "export const out = run(() => new Parcel());",
      ],
      "",
    ],
    [
      "a library map's value type parameter at a place an intersection opens",
      [
        parcel,
        'function dump<T>(m: Map<string, T> & { tag?: string }): string { return JSON.stringify(m.get("a")); }',
        'export const out = dump(new Map([["a", new Parcel()]]));',
      ],
      "",
    ],
    [
      "a callback's result type parameter at a place an intersection opens",
      [
        parcel,
        "function run<T>(f: (() => T) & { tag?: string }): string { return JSON.stringify(f()); }",
        "export const out = run(() => new Parcel());",
      ],
      "",
    ],
    [
      "a generic function passed as a callback",
      [
        parcel,
        "function serialize<T>(x: T): string { return JSON.stringify(x); }",
        "export const out = [new Parcel()].map(serialize);",
      ],
      "",
    ],
    [
      "a generic function stored where its calls cannot be read",
      [
        parcel,
        "function serialize<T>(x: T): string { return JSON.stringify(x); }",
        "export const table = [serialize];",
        "export const made = new Parcel();",
      ],
      "",
    ],
    [
      "a generic method an interface dispatches to",
      [
        parcel,
        "interface Saver { save<T>(x: T): string }",
        "class JsonSaver implements Saver { save<T>(x: T): string { return JSON.stringify(x); } }",
        "const s: Saver = new JsonSaver();",
        "export const out = s.save(new Parcel());",
      ],
      "",
    ],
    [
      "a generic method an abstract base dispatches to",
      [
        parcel,
        "abstract class Saver { abstract save<T>(x: T): string; }",
        "class JsonSaver extends Saver { save<T>(x: T): string { return JSON.stringify(x); } }",
        "const s: Saver = new JsonSaver();",
        "export const out = s.save(new Parcel());",
      ],
      "",
    ],
    [
      "a parameter typed object",
      [
        parcel,
        "function save(x: object): string { return JSON.stringify(x); }",
        "export const out = save(new Parcel());",
      ],
      "",
    ],
    [
      "a parameter typed by the empty object type",
      [
        parcel,
        "function save(x: {}): string { return JSON.stringify(x); }",
        "export const out = save(new Parcel());",
      ],
      "",
    ],
    [
      "a project function's result typed any",
      [
        parcel,
        "function make(): any { return new Parcel(); }",
        "export const out = JSON.stringify(make());",
      ],
      "",
    ],
    [
      "a project function's result typed unknown, held in a variable",
      [
        parcel,
        "function make(): unknown { return new Parcel(); }",
        "const made = make();",
        "export const out = JSON.stringify(made);",
      ],
      "",
    ],
    [
      "a this parameter typed by the class, through call",
      [
        parcel,
        "function dump(this: Parcel): string { return JSON.stringify(this); }",
        "export const out = dump.call(new Parcel());",
      ],
      "",
    ],
    [
      "a this parameter typed by a type parameter the class constrains, through call",
      [
        parcel,
        "function dump<T extends Parcel>(this: T): string { return JSON.stringify(this); }",
        "export const out = dump.call(new Parcel());",
      ],
      "",
    ],
    [
      "a this parameter typed by a type parameter nothing constrains, through call",
      [
        parcel,
        "function dump<T>(this: T): string { return JSON.stringify(this); }",
        "export const out = dump.call(new Parcel());",
      ],
      "",
    ],
    [
      "a this parameter typed unknown, through call",
      [
        parcel,
        "function dump(this: unknown): string { return JSON.stringify(this); }",
        "export const out = dump.call(new Parcel());",
      ],
      "",
    ],
    [
      "an outside function's result whose type names a structural supertype",
      [
        parcel,
        'import { normalize } from "./outside.js";',
        "export const out = JSON.stringify(normalize(new Parcel()));",
      ],
      "export declare function normalize(x: { id: number }): { id: number };\n",
    ],
    [
      "an annotated variable passed to a generic serializer",
      [
        parcel,
        "interface HasId { id: number }",
        "function save<T>(x: T): string { return JSON.stringify(x); }",
        "const h: HasId = new Parcel();",
        "export const out = save(h);",
      ],
      "",
    ],
    [
      "a parameter typed by an interface the class implements structurally",
      [
        parcel,
        "interface HasId { id: number }",
        "function save(x: HasId): string { return JSON.stringify(x); }",
        "export const out = save(new Parcel());",
      ],
      "",
    ],
    [
      "a parameter typed by a type literal the class matches",
      [
        parcel,
        "function save(x: { id: number }): string { return JSON.stringify(x); }",
        "export const out = save(new Parcel());",
      ],
      "",
    ],
    [
      "a parameter typed by a base class",
      [
        "class Base { id = 1; }",
        "class Parcel extends Base { private secret = 1; }",
        "function save(b: Base): string { return JSON.stringify(b); }",
        "export const out = save(new Parcel());",
      ],
      "",
    ],
    [
      "a generic interface that instantiates itself afresh at each level, from a declared function, its value first",
      [
        parcel,
        "interface Chain<T> { value: T; next?: Chain<[T]> }",
        "declare function make(): Chain<Parcel>;",
        "export const out = JSON.stringify(make());",
      ],
      "",
    ],
    [
      "a spread of a parameter typed object",
      [
        parcel,
        "function send(x: object): string { return JSON.stringify({ ...x }); }",
        "export const out = send(new Parcel());",
      ],
      "",
    ],
    [
      "a spread of a variable an interface types",
      [
        parcel,
        "interface HasId { id: number }",
        "const h: HasId = new Parcel();",
        "export const out = JSON.stringify({ ...h });",
      ],
      "",
    ],
    [
      "a spread of a variable a base class types",
      [
        "class Base { id = 1; }",
        "class Parcel extends Base { private secret = 1; }",
        "const b: Base = new Parcel();",
        "export const out = JSON.stringify({ ...b });",
      ],
      "",
    ],
    [
      "an object literal's getter",
      [
        parcel,
        "const p = new Parcel();",
        "export const out = JSON.stringify({ get data() { return p; } });",
      ],
      "",
    ],
    [
      "an object literal's getter over a parameter",
      [
        parcel,
        "function send(p: Parcel): string { return JSON.stringify({ get data() { return p; } }); }",
        "export const out = send(new Parcel());",
      ],
      "",
    ],
    [
      "an object literal's getter beside a data member",
      [
        parcel,
        "const box = { n: 1, get inner(): Parcel { return new Parcel(); } };",
        "export const out = JSON.stringify(box);",
      ],
      "",
    ],
    [
      "an object literal's getter typed unknown",
      [
        parcel,
        "const p = new Parcel();",
        "export const out = JSON.stringify({ get data(): unknown { return p; } });",
      ],
      "",
    ],
    [
      "a class's toJSON result",
      [
        parcel,
        "class Wrap { toJSON() { return new Parcel(); } }",
        "export const out = JSON.stringify(new Wrap());",
      ],
      "",
    ],
    [
      "a class's toJSON result beside a data member",
      [
        parcel,
        "class Box { hidden = 1; toJSON(): Parcel { return new Parcel(); } }",
        "export const out = JSON.stringify(new Box());",
      ],
      "",
    ],
    [
      "a toJSON a base class declares",
      [
        parcel,
        "class Base { toJSON(): Parcel { return new Parcel(); } }",
        "class Sub extends Base { n = 1; }",
        "export const out = JSON.stringify(new Sub());",
      ],
      "",
    ],
    [
      "a subclass's toJSON behind a variable a base class types",
      [
        parcel,
        "class Base { id = 1; }",
        "class Derived extends Base { toJSON() { return new Parcel(); } }",
        "const b: Base = new Derived();",
        "export const out = JSON.stringify(b);",
      ],
      "",
    ],
    [
      "a class's toJSON result typed unknown",
      [
        parcel,
        "class Wrap { toJSON(): unknown { return new Parcel(); } }",
        "export const out = JSON.stringify(new Wrap());",
      ],
      "",
    ],
    [
      "a class's toJSON getter that returns a function",
      [
        parcel,
        "class Wrap { get toJSON() { return () => new Parcel(); } }",
        "export const out = JSON.stringify(new Wrap());",
      ],
      "",
    ],
    [
      "a generic subclass of a concrete base, through a parameter the base types",
      [
        parcel,
        "class Base { id = 1; }",
        "class Derived<T> extends Base { constructor(public extra: T) { super(); } }",
        "function save(b: Base): string { return JSON.stringify(b); }",
        "export const out = save(new Derived(new Parcel()));",
      ],
      "",
    ],
    [
      "a generic subclass of a concrete base that assigns its member",
      [
        parcel,
        "class Base { n = 1; }",
        "class Sub<T> extends Base { value: T; constructor(value: T) { super(); this.value = value; } }",
        "function save(b: Base): string { return JSON.stringify(b); }",
        "export const out = save(new Sub(new Parcel()));",
      ],
      "",
    ],
    [
      "a member typed unknown its initializer writes",
      [
        parcel,
        "class X { extra: unknown = new Parcel(); }",
        "export const out = JSON.stringify(new X());",
      ],
      "",
    ],
    [
      "a member typed unknown a constructor's this assignment writes",
      [
        parcel,
        "class X { extra: unknown; constructor() { this.extra = new Parcel(); } }",
        "export const out = JSON.stringify(new X());",
      ],
      "",
    ],
    [
      "a member typed unknown a this element assignment writes",
      [
        parcel,
        'class X { extra: unknown; constructor() { this["extra"] = new Parcel(); } }',
        "export const out = JSON.stringify(new X());",
      ],
      "",
    ],
    [
      "a member an interface types its initializer writes",
      [
        parcel,
        "interface HasId { id: number }",
        "class X { extra: HasId = new Parcel(); }",
        "export const out = JSON.stringify(new X());",
      ],
      "",
    ],
    [
      "a member typed object its initializer writes",
      [
        parcel,
        "class Box { item: object = new Parcel(); }",
        "export const out = JSON.stringify(new Box());",
      ],
      "",
    ],
    [
      "a member typed by the empty object type its initializer writes",
      [
        parcel,
        "class Box { item: {} = new Parcel(); }",
        "export const out = JSON.stringify(new Box());",
      ],
      "",
    ],
    [
      "a member typed object a constructor's this assignment writes",
      [
        parcel,
        "class Box { item: object; constructor() { this.item = new Parcel(); } }",
        "export const out = JSON.stringify(new Box());",
      ],
      "",
    ],
    [
      "a member typed object a method's this assignment writes",
      [
        parcel,
        "class Box { item: object = {}; put(p: Parcel): void { this.item = p; } }",
        "const box = new Box();",
        "box.put(new Parcel());",
        "export const out = JSON.stringify(box);",
      ],
      "",
    ],
    [
      "a subclass member typed unknown behind a variable a base class types",
      [
        parcel,
        "class Base { id = 1; }",
        "class Derived extends Base { extra: unknown = new Parcel(); }",
        "const b: Base = new Derived();",
        "export const out = JSON.stringify(b);",
      ],
      "",
    ],
    [
      "a generic method a non-generic interface method dispatches to",
      [
        parcel,
        "interface Saver { save(x: unknown): string }",
        "class JsonSaver implements Saver { save<T>(x: T): string { return JSON.stringify(x); } }",
        "const s: Saver = new JsonSaver();",
        "export const out = s.save(new Parcel());",
      ],
      "",
    ],
    [
      "a generic method a non-generic interface method dispatches to, through a parameter",
      [
        parcel,
        "interface Sink { write(value: object): void }",
        "class Impl implements Sink { write<T>(value: T): void { JSON.stringify(value); } }",
        "export function go(s: Sink): void { s.write(new Parcel()); }",
        "go(new Impl());",
      ],
      "",
    ],
    [
      "a generic method a non-generic abstract method dispatches to",
      [
        parcel,
        "abstract class Saver { abstract save(x: unknown): string; }",
        "class JsonSaver extends Saver { save<T>(x: T): string { return JSON.stringify(x); } }",
        "const s: Saver = new JsonSaver();",
        "export const out = s.save(new Parcel());",
      ],
      "",
    ],
    [
      "a generic method whose parameters do not name its type parameter, a non-generic interface method dispatching to it",
      [
        parcel,
        "interface Saver { save(x: unknown): string }",
        "class JsonSaver implements Saver { last: unknown; save<T>(x: unknown): string { this.last = x; return JSON.stringify(this.last as T); } }",
        "const s: Saver = new JsonSaver();",
        "export const out = s.save(new Parcel());",
      ],
      "",
    ],
    [
      "Object.assign onto this",
      [
        parcel,
        "class Wrap { constructor(x: Parcel) { Object.assign(this, x); } }",
        "export const out = JSON.stringify(new Wrap(new Parcel()));",
      ],
      "",
    ],
  ])(
    "holds back every member of the class, through %s",
    (_form, main, declarations) => {
      expect(memberFindings(main, declarations).filter((one) => one.includes("Parcel."))).toEqual(
        [],
      );
    },
    LOAD_TIMEOUT,
  );
});

describe("a package's generic type that instantiates itself afresh at each level", () => {
  it(
    "holds back every member of the class its value holds",
    () => {
      expect(
        retainedIn(
          [
            'import type { Chain } from "chain";',
            "class Parcel { private secret = 1; id = 2; }",
            "const chain: Chain<Parcel> = { value: new Parcel() };",
            "export const out = JSON.stringify(chain);",
          ],
          {
            "node_modules/chain/package.json": JSON.stringify({
              name: "chain",
              version: "1.0.0",
              types: "index.d.ts",
            }),
            "node_modules/chain/index.d.ts":
              "export interface Chain<T> { value: T; next?: Chain<[T]> }\n",
          },
        )
          .map((line) => line.replace(/ \d+:\d+ /u, " "))
          .sort(),
      ).toEqual(["Parcel.id passed to JSON.stringify", "Parcel.secret passed to JSON.stringify"]);
    },
    LOAD_TIMEOUT,
  );
});

describe("a package's generic type that instantiates itself afresh at each level, from a declared function", () => {
  it(
    "holds back every member of the class its value holds, its value declared first",
    () => {
      expect(
        retainedIn(
          [
            'import type { Chain } from "chain";',
            "class Parcel { private secret = 1; id = 2; }",
            "declare function make(): Chain<Parcel>;",
            "export const out = JSON.stringify(make());",
          ],
          {
            "node_modules/chain/package.json": JSON.stringify({
              name: "chain",
              version: "1.0.0",
              types: "index.d.ts",
            }),
            "node_modules/chain/index.d.ts":
              "export interface Chain<T> { value: T; next?: Chain<[T]> }\n",
          },
        )
          .map((line) => line.replace(/ \d+:\d+ /u, " "))
          .filter((line) => line.startsWith("Parcel."))
          .sort(),
      ).toEqual(["Parcel.id passed to JSON.stringify", "Parcel.secret passed to JSON.stringify"]);
    },
    LOAD_TIMEOUT,
  );
});

describe("a serialized type larger than the walk reads", () => {
  it(
    "holds back every member of every class past the walk's bound",
    () => {
      const count = 4300;
      const ids = Array.from({ length: count }, (_none, at) => at);
      expect(
        memberFindings([
          ...ids.map((at) => `class C${String(at)} { private secret = ${String(at)}; }`),
          `interface Root { ${ids.map((at) => `c${String(at)}: C${String(at)};`).join(" ")} }`,
          "function save(r: Root): string { return JSON.stringify(r); }",
          `export const out = save({ ${ids.map((at) => `c${String(at)}: new C${String(at)}()`).join(", ")} });`,
        ]).filter((one) => one.includes(".secret")),
      ).toEqual([]);
    },
    LOAD_TIMEOUT * 3,
  );
});

describe("an outside place written over a type parameter", () => {
  it.each([
    [
      "an object type over the type parameter",
      "<T>(x: { value: T }): void",
      "emit({ value: new Parcel() });",
    ],
    [
      "a mapped type whose template is an object type over the type parameter",
      '<T>(x: { [K in "box"]: { value: T } }): void',
      "emit({ box: { value: new Parcel() } });",
    ],
  ])(
    "holds back the conversions of a value passed to %s",
    (_form, signature, call) => {
      expect(
        retainedIn(
          [
            'import { emit } from "./outside.ts";',
            'class Parcel { id = 1; toString(): string { return ""; } }',
            call,
          ],
          { "outside.ts": `export declare function emit${signature};\n` },
        )
          .map((line) => line.replace(/ \d+:\d+ /u, " "))
          .sort(),
      ).toEqual(["Parcel.id passed to emit", "Parcel.toString passed to emit"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "holds back the conversions of a value passed to an outside method whose result is this",
    () => {
      expect(
        retainedIn(
          [
            'import { Log } from "./outside.ts";',
            'class Parcel { id = 1; toString(): string { return ""; } }',
            "const log = new Log<Parcel>();",
            "log.add(new Parcel());",
          ],
          { "outside.ts": "export declare class Log<T> { add(x: T): this; }\n" },
        )
          .map((line) => line.replace(/ \d+:\d+ /u, " "))
          .sort(),
      ).toEqual(["Parcel.id passed to log.add", "Parcel.toString passed to log.add"]);
    },
    LOAD_TIMEOUT,
  );

  it.each([
    ["an object type the result is", "<T>(x: T): { value: T }", "emit(new Parcel());"],
    ["a promise of an object type", "<T>(body: T): Promise<{ data: T }>", "emit(new Parcel());"],
    [
      "an object type beside another member",
      "<T>(body: T): { sent: T; ok: boolean }",
      "emit(new Parcel());",
    ],
  ])(
    "holds back the conversions of a value passed to an outside function whose result holds it in %s",
    (_form, signature, call) => {
      expect(
        retainedIn(
          [
            'import { emit } from "./outside.ts";',
            'class Parcel { id = 1; toString(): string { return ""; } }',
            call,
          ],
          { "outside.ts": `export declare function emit${signature};\n` },
        )
          .map((line) => line.replace(/ \d+:\d+ /u, " "))
          .sort(),
      ).toEqual(["Parcel.id passed to emit", "Parcel.toString passed to emit"]);
    },
    LOAD_TIMEOUT,
  );

  it.each([["a function the result returns", "<T>(x: T): () => T"]])(
    "holds back nothing of a value handed back through %s",
    (_form, signature) => {
      expect(
        retainedIn(
          [
            'import { emit } from "./outside.ts";',
            'import { Parcel } from "./parcel.ts";',
            "console.log(emit(new Parcel()));",
          ],
          {
            "parcel.ts": 'export class Parcel { id = 1; toString(): string { return ""; } }\n',
            "outside.ts": `import type { Parcel } from "./parcel.ts";\nexport declare function emit${signature};\n`,
          },
        ).filter((line) => line.includes("passed to emit")),
      ).toEqual([]);
    },
    LOAD_TIMEOUT,
  );
});

describe("a generic function's result read through the call that instantiates it", () => {
  it(
    "takes nothing from what the type parameter's constraint holds at other calls",
    () => {
      const held = retainedIn(
        [
          'import { hold } from "./outside.ts";',
          "const strings: string[] = [];",
          "function listed<A extends unknown[]>(...items: A): A { return items; }",
          "function save<T>(...v: [T] & unknown[]): string { return JSON.stringify(v); }",
          'class Sent { id = 1; toString(): string { return ""; } }',
          "hold.apply(undefined, listed(new Sent(), ...strings));",
          'class Saved { id = 1; toString(): string { return ""; } }',
          "save.apply(undefined, [new Saved()]);",
        ],
        { "outside.ts": "export declare function hold<T>(...v: T[]): void;\n" },
      ).map((line) => line.split(" ")[0]);
      expect([...new Set(held)].sort()).toEqual(["Saved.id", "Sent.id", "Sent.toString"]);
    },
    LOAD_TIMEOUT,
  );
});
