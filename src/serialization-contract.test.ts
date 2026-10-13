import { mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { emitterInputOf, findingsOf } from "../__test-helpers__/emitter-input.ts";
import { fixture } from "../__test-helpers__/fixtures.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import { treeFindings } from "../__test-helpers__/tree-findings.ts";
import { runSweep, type RunSweep } from "./analysis.ts";
import { resolve } from "./resolve.ts";
import { run, type Writer } from "./run.ts";
import { scopeForDir } from "./scope.ts";
import { openEngine } from "./session.ts";

const TARGET = fixture("projects", "serialization-contract");
const CHECKED = fixture("projects", "serialization-checked-and-ambient");

const LOAD_TIMEOUT = 60_000;

/** The fixture swept for production, under its own configuration or the one given. */
function sweepFixture(document?: string, target = TARGET): RunSweep {
  const path = join(target, "deadset.json");
  const { config } = resolve({
    repository: document ?? readFileSync(path, "utf8"),
    repositoryLabel: path,
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
  return swept.retained
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
      "Shaped.field",
      "Registry.entries",
      "Deferred.value",
      "Census.count",
      "Journal.entry",
      "Outline.depth",
      "Kept.unused",
    ]);
  });

  it("reads JSON.stringify and the unknown parameters of ambient declarations where the configuration names no serializer", () => {
    const unconfigured = sweepFixture(JSON.stringify({ target: { kind: "application" } }));

    expect(serialized(unconfigured, "Order", "Payload", "Frame")).toEqual([
      "Order.id src/main.ts:45:16 passed to JSON.stringify",
      "Order.items src/main.ts:45:16 passed to JSON.stringify",
      'Payload.body src/main.ts:47:28 passed to object({body:""}).parse',
    ]);
    expect(deadMembers(unconfigured)).not.toContain("Payload.body");
    expect(deadMembers(unconfigured)).toContain("Frame.bytes");
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
      "Never.ghost src/main.ts:152:20 passed to client.postMessage",
      "AnyCast.erased src/main.ts:154:20 passed to client.postMessage",
    ]);
  });

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
      repository: readFileSync(document, "utf8"),
      repositoryLabel: document,
    });

    expect(
      findingsOf(emitterInputOf(CHECKED, config)).map(
        (finding) =>
          `${finding.code} ${finding.position.path}:${String(finding.position.line)} ${finding.symbol.name}`,
      ),
    ).toEqual([
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

function retainedIn(main: readonly string[]): string[] {
  const root = writeProject({
    "package.json": JSON.stringify({ name: "@example/tree", private: true, type: "module" }),
    "main.ts": `${main.join("\n")}\n`,
    ...SINK,
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
    return swept.retained
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
    "holds back what a typed rest parameter's type reaches, and nothing of the class an argument is",
    () => {
      expect(
        retainedIn([
          "interface Sized { size: number }",
          "class Crate { size = 1; }",
          "function pack(...items: Sized[]): void { JSON.stringify(items); }",
          "pack(new Crate());",
        ]),
      ).toEqual(["Sized.size 3:57 passed to JSON.stringify"]);
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
          repository: JSON.stringify({
            target: { kind: "application" },
            ts: { entry_files: ["main.ts"] },
          }),
          repositoryLabel: "deadset.json",
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

        expect(swept.retained.filter((held) => held.class === "serialization-contract")).toEqual(
          [],
        );
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
