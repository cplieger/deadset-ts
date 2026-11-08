import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nodeHost } from "../../bin/node-host.ts";
import { writeProject } from "../../__test-helpers__/projects.ts";
import { runSweep, type RunSweep } from "../analysis.ts";
import { resolve } from "../resolve.ts";
import { scopeForDir } from "../scope.ts";
import { openEngine } from "../session.ts";

const LOAD_TIMEOUT = 60_000;

const SINK = {
  "node_modules/@example/sink/package.json": JSON.stringify({
    name: "@example/sink",
    version: "0.0.0",
    types: "./index.d.ts",
  }),
  "node_modules/@example/sink/index.d.ts": [
    "export declare function register(target: unknown): void;",
    "export declare function Inject(): any;",
    "",
  ].join("\n"),
};

/** One project of the files given swept for production, the `ts` section and the other sections given. */
function swept(
  files: Readonly<Record<string, string>>,
  ts: object = {},
  sections: object = {},
): RunSweep {
  const root = writeProject({
    "package.json": JSON.stringify({ name: "@example/tree", private: true, type: "module" }),
    ...SINK,
    ...files,
  });
  try {
    const { config } = resolve({
      repository: {
        text: JSON.stringify({
          target: { kind: "application" },
          ts: { entry_files: Object.keys(files).filter((path) => !path.endsWith(".json")), ...ts },
          ...sections,
        }),
        label: "deadset.json",
      },
    });
    const host = nodeHost();
    return runSweep(openEngine({ collectTiming: false }), host, scopeForDir(host, root), config, {
      marked: [],
      mode: { production: true },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function nameOf(run: RunSweep, id: string): string {
  return run.matrix.union.symbols.find((symbol) => symbol.id === id)?.name ?? id;
}

/** Each record that held a declaration back: its name, site, class and detail. */
function retained(run: RunSweep): string[] {
  return run.sweep.retained.map(
    (held) =>
      `${nameOf(run, held.id)} ${held.site.path}:${String(held.site.line)}:${String(held.site.column)} ${held.class}: ${held.detail}`,
  );
}

/** Each member the sweep reports dead. */
function deadMembers(run: RunSweep): string[] {
  return run.sweep.candidates
    .map((candidate) => nameOf(run, candidate.id))
    .filter((name) => name.includes("."));
}

/** The decorator class holds every decorated member back, so a container's own reach shows only without it. */
const NO_DECORATOR = { exemptions: { disabled: ["decorator"] } };

const main = (...lines: readonly string[]): Record<string, string> => ({
  "main.ts": `${lines.join("\n")}\n`,
});

describe("a value of the polymorphic `this` type reaching a serializer", () => {
  it(
    "holds back the class's data members, and the run finishes",
    () => {
      const run = swept(
        main(
          "export class Record {",
          '  key = "";',
          "  latest(): this { return this; }",
          "  save(): string { return JSON.stringify(this.latest()); }",
          "}",
          "new Record().save();",
        ),
      );
      expect(retained(run)).toEqual([
        "Record.key main.ts:4:42 serialization-contract: passed to JSON.stringify",
      ]);
    },
    LOAD_TIMEOUT,
  );
});

describe("each value an argument can be, read alone by every detector", () => {
  it(
    "holds back both classes a conditional, `??` and `||` hand a serializer, though one is the other's structural twin",
    () => {
      const run = swept(
        main(
          "class Left { id = 1; }",
          "class Right { id = 1; }",
          "class First { id = 1; }",
          "class Second { id = 1; }",
          "declare const flag: boolean;",
          "declare const maybe: First | undefined;",
          "JSON.stringify(flag ? new Left() : new Right());",
          "JSON.stringify(maybe ?? new Second());",
          "JSON.stringify(maybe || new Second());",
        ),
      );
      expect(deadMembers(run)).toEqual([]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "holds back the members of a subclass a conditional's union reduces into its base",
    () => {
      const run = swept(
        main(
          "class Base { id = 1; }",
          "class Derived extends Base { extra = 2; }",
          "declare const flag: boolean;",
          "JSON.stringify(flag ? new Base() : new Derived());",
          "function relay(value: unknown): void { JSON.stringify(value); }",
          "relay(flag ? new Base() : new Derived());",
        ),
      );
      expect(retained(run)).toEqual([
        "Base.id main.ts:4:23 serialization-contract: passed to JSON.stringify",
        "Base.id main.ts:6:14 serialization-contract: passed to relay",
        "Derived.extra main.ts:4:36 serialization-contract: passed to JSON.stringify",
        "Derived.extra main.ts:6:27 serialization-contract: passed to relay",
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "holds back the class of a value an assertion erases before it reaches a serializer",
    () => {
      const run = swept(
        main(
          "class Cast { id = 1; }",
          "class Checked { id = 1; }",
          "JSON.stringify(new Cast() as unknown);",
          "JSON.stringify(new Checked() satisfies object);",
        ),
      );
      expect(deadMembers(run)).toEqual([]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "holds back nothing of the left operand of `&&`, whose value is never an object",
    () => {
      const run = swept(
        main(
          'import { register, Inject } from "@example/sink";',
          "class Left { @Inject() left: unknown; }",
          "class Right { @Inject() right: unknown; }",
          "register(Left && Right);",
        ),
        { injection_registrations: [{ module: "@example/sink", name: "register" }] },
        NO_DECORATOR,
      );
      expect(deadMembers(run)).toEqual(["Left.left"]);
    },
    LOAD_TIMEOUT,
  );
});

describe("a registration reached through a method of Function.prototype", () => {
  it(
    "registers the class a call through `call`, `apply` or `bind` passes",
    () => {
      const run = swept(
        main(
          "class Called extends HTMLElement { connectedCallback(): void {} }",
          "class Applied extends HTMLElement { connectedCallback(): void {} }",
          "class Bound extends HTMLElement { connectedCallback(): void {} }",
          'customElements.define.call(customElements, "x-called", Called);',
          'customElements.define.apply(customElements, ["x-applied", Applied]);',
          'customElements.define.bind(customElements, "x-bound")(Bound);',
        ),
      );
      expect(deadMembers(run)).toEqual([]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "registers the class a `bind` gives, though the bound function is called elsewhere",
    () => {
      const run = swept(
        main(
          "class Later extends HTMLElement { connectedCallback(): void {} }",
          'const later = customElements.define.bind(customElements, "x-later", Later);',
          "queueMicrotask(later);",
        ),
      );
      expect(deadMembers(run)).toEqual([]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "registers the class a wrapper is handed through `call`",
    () => {
      const run = swept(
        main(
          "class Wrapped extends HTMLElement { connectedCallback(): void {} }",
          "function install(name: string, element: CustomElementConstructor): void {",
          "  customElements.define(name, element);",
          "}",
          'install.call(undefined, "x-wrapped", Wrapped);',
        ),
      );
      expect(deadMembers(run)).toEqual([]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "registers the class a JavaScript file hands on through `call` and `apply`, to the registry or a wrapper",
    () => {
      const run = swept({
        "main.js": [
          "class Called extends HTMLElement { connectedCallback() {} }",
          "class Applied extends HTMLElement { connectedCallback() {} }",
          "class Wrapped extends HTMLElement { connectedCallback() {} }",
          "function install(name, element) { customElements.define(name, element); }",
          'customElements.define.call(customElements, "x-called", Called);',
          'customElements.define.apply(customElements, ["x-applied", Applied]);',
          'install.call(undefined, "x-wrapped", Wrapped);',
          "",
        ].join("\n"),
      });
      expect(deadMembers(run)).toEqual([]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "constructs the class a configured registration is handed through `call`",
    () => {
      const run = swept(
        main(
          'import { register, Inject } from "@example/sink";',
          "class Service { @Inject() dependency: unknown; }",
          "register.call(undefined, Service);",
        ),
        { injection_registrations: [{ module: "@example/sink", name: "register" }] },
        NO_DECORATOR,
      );
      expect(retained(run)).toEqual([
        "Service.dependency main.ts:3:26 injection-container: registered by register",
      ]);
    },
    LOAD_TIMEOUT,
  );
});

const RUNNERS = {
  "node_modules/vitest/package.json": JSON.stringify({ name: "vitest", types: "./index.d.ts" }),
  "node_modules/vitest/index.d.ts":
    "export declare const vi: { stubGlobal(name: string | symbol | number, value: unknown): unknown };\n",
  "node_modules/@jest/globals/package.json": JSON.stringify({
    name: "@jest/globals",
    types: "./index.d.ts",
  }),
  "node_modules/@jest/globals/index.d.ts":
    "export declare const jest: { replaceProperty<T extends object, K extends keyof T>(object: T, key: K, value: T[K]): unknown };\n",
};

/** The `jest` global `@types/jest` declares, which the compiler reads where `types` names it. */
const AMBIENT_JEST = {
  "tsconfig.json": JSON.stringify({
    compilerOptions: { strict: true, types: ["jest"] },
    include: ["main.ts"],
  }),
  "node_modules/@types/jest/package.json": JSON.stringify({
    name: "@types/jest",
    types: "./index.d.ts",
  }),
  "node_modules/@types/jest/index.d.ts":
    "declare namespace jest { function replaceProperty<T extends object, K extends keyof T>(object: T, key: K, value: T[K]): unknown; }\n",
};

/** A global a types package declares through a class of a module, as `@types/node` declares `URL`. */
const CLASS_GLOBAL = {
  "tsconfig.json": JSON.stringify({
    compilerOptions: { strict: true, types: ["transport"] },
    include: ["main.ts"],
  }),
  "node_modules/@types/transport/package.json": JSON.stringify({
    name: "@types/transport",
    types: "./index.d.ts",
  }),
  "node_modules/@types/transport/index.d.ts": [
    'declare module "transport" {',
    "  export class Transport { readyState: number; send(data: string): void; close(): void; }",
    "}",
    'declare var Transport: typeof import("transport").Transport;',
    "",
  ].join("\n"),
};

const SOCKET = [
  "class FakeSocket {",
  "  readyState = 0;",
  "  send(data: string): void { void data; }",
  "  close(): void {}",
  "  spare(): void {}",
  "}",
];

const IMPORTED = ['import { vi } from "vitest";', 'import { jest } from "@jest/globals";'];

describe("a class installed as a global the platform's code constructs", () => {
  it.each([
    [
      "an assignment to globalThis",
      IMPORTED,
      "globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;",
    ],
    [
      "an assignment to window",
      IMPORTED,
      "window.WebSocket = FakeSocket as unknown as typeof WebSocket;",
    ],
    [
      "an assignment to self",
      IMPORTED,
      "self.WebSocket = FakeSocket as unknown as typeof WebSocket;",
    ],
    [
      "an assignment through an erased receiver",
      IMPORTED,
      "(globalThis as any).WebSocket = FakeSocket;",
    ],
    ["an assignment by a written key", IMPORTED, '(globalThis as any)["WebSocket"] = FakeSocket;'],
    [
      "Object.defineProperty",
      IMPORTED,
      'Object.defineProperty(globalThis, "WebSocket", { value: FakeSocket });',
    ],
    ["vi.stubGlobal", IMPORTED, 'vi.stubGlobal("WebSocket", FakeSocket);'],
    [
      "jest.replaceProperty of @jest/globals",
      IMPORTED,
      'jest.replaceProperty(globalThis, "WebSocket", FakeSocket as unknown as typeof WebSocket);',
    ],
    [
      "jest.replaceProperty of the jest global",
      [],
      'jest.replaceProperty(globalThis, "WebSocket", FakeSocket as unknown as typeof WebSocket);',
    ],
  ])(
    "holds back the members the global's instance type names, installed by %s",
    (_form, imports, install) => {
      const run = swept({
        ...RUNNERS,
        ...(imports.length === 0 ? AMBIENT_JEST : {}),
        ...main(
          ...imports,
          ...imports.map((line) => `void ${line.split(" ")[2] ?? ""};`),
          ...SOCKET,
          install,
        ),
      });
      expect(deadMembers(run)).toEqual(["FakeSocket.spare"]);
    },
    LOAD_TIMEOUT,
  );

  it.each([
    [
      "an assignment to globalThis",
      "globalThis.Transport = FakeSocket as unknown as typeof Transport;",
    ],
    ["vi.stubGlobal", 'vi.stubGlobal("Transport", FakeSocket);'],
  ])(
    "holds back the members a global declared through a class names, installed by %s",
    (_form, install) => {
      const run = swept({
        ...RUNNERS,
        ...CLASS_GLOBAL,
        ...main('import { vi } from "vitest";', "void vi;", ...SOCKET, install),
      });
      expect(deadMembers(run)).toEqual(["FakeSocket.spare"]);
    },
    LOAD_TIMEOUT,
  );

  it.each([
    ["a function", "globalThis.WebSocket = (function () {}) as unknown as typeof WebSocket;"],
    [
      "a class to a global property whose type has no construct signature",
      "(globalThis as any).document = FakeSocket;",
    ],
    [
      "a class to a key the global object does not declare",
      "(globalThis as any).sockets = FakeSocket;",
    ],
    [
      "a class to an object that is not the global one",
      "const holder: { WebSocket?: unknown } = {}; holder.WebSocket = FakeSocket;",
    ],
    [
      "a class by a runner's method of another package",
      'stubs.stubGlobal("WebSocket", FakeSocket);',
    ],
  ])(
    "holds back nothing of a class where the program writes %s",
    (_form, install) => {
      const run = swept({
        ...main(
          "const stubs = { stubGlobal(name: string, value: unknown): void { void name; void value; } };",
          ...SOCKET,
          "void new FakeSocket();",
          install,
        ),
      });
      expect(deadMembers(run).sort()).toEqual([
        "FakeSocket.close",
        "FakeSocket.readyState",
        "FakeSocket.send",
        "FakeSocket.spare",
      ]);
    },
    LOAD_TIMEOUT,
  );
});
