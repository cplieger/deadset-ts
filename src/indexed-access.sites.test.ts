import { describe, expect, it } from "vitest";
import { treeFindings } from "../__test-helpers__/tree-findings.ts";

/** The findings about a member of `owner` in a tree whose `main.ts` is `lines`. */
function memberFindings(owner: string, lines: readonly string[]): readonly string[] {
  return treeFindings({ "main.ts": [...lines, ""].join("\n") }).filter((one) =>
    one.includes(`${owner}.`),
  );
}

describe("a member an indexed access reads through a site", () => {
  it("is read for each key a type parameter's literal constraint requires", () => {
    expect(
      memberFindings("Payload", [
        'type Kind = "a" | "b";',
        "interface Payload { a: string; b: number; c: boolean }",
        "function pick<K extends Kind>(): Payload[K] { return undefined as never; }",
        'console.log(pick<"a">());',
      ]),
    ).toEqual(["DS1003 Payload.c"]);
  });

  it("is read where a literal reaches a non-generic function's keyof parameter", () => {
    expect(
      memberFindings("Events", [
        "interface Events { closed: string; opened: string }",
        "function clear(event: keyof Events): void { console.log(event); }",
        'clear("closed");',
      ]),
    ).toEqual(["DS1003 Events.opened"]);
  });

  it("is read for the literal keys of an index that mixes them with a non-literal type", () => {
    expect(
      memberFindings("Handlers", [
        "interface Handlers { click: string; key: string; [slot: number]: string }",
        "type Boxed<K extends keyof Handlers> = { v: Handlers[K] };",
        'const boxed: Boxed<"click" | number> = { v: "" };',
        'const written: Handlers["click" | number] = "";',
        "console.log(boxed.v, written);",
      ]),
    ).toEqual(["DS1003 Handlers.key"]);
  });

  it("is read where a new expression fixes a generic class's type parameter", () => {
    expect(
      memberFindings("Sig", [
        "interface Sig { a: string; b: string }",
        "class Box<K extends keyof Sig> { constructor(readonly key: K) {} value?: Sig[K]; }",
        'console.log(new Box("a"));',
      ]),
    ).toEqual(["DS1003 Sig.b"]);
  });

  it("is read where a new expression calls a generic construct signature", () => {
    expect(
      memberFindings("Sig", [
        "interface Sig { a: string; b: string }",
        "declare const make: new <K extends keyof Sig>(key: K) => { v: Sig[K] };",
        'console.log(new make("a"));',
      ]),
    ).toEqual(["DS1003 Sig.b"]);
  });

  it("is read where a call fixes a generic an object literal property holds", () => {
    expect(
      memberFindings("Payload", [
        "interface Payload { a: string; b: number }",
        "const o = { pick: <K extends keyof Payload>(): Payload[K] => undefined as never };",
        'console.log(o.pick<"a">());',
      ]),
    ).toEqual(["DS1003 Payload.b"]);
  });

  it("is read where a subclass's call fixes the key its generic base class's method takes", () => {
    const lines = [
      "interface Events { open: []; close: [] }",
      'class Stopper extends Emitter<Events> { stop(): void { this.emit("close"); } }',
      "new Stopper().stop();",
    ];
    const declared = "declare class Emitter<T> { emit<K extends keyof T>(event: K): boolean; }";
    expect(memberFindings("Events", [declared, ...lines])).toEqual(["DS1003 Events.open"]);
    expect(
      treeFindings({
        "node_modules/emitter-lib/package.json":
          '{ "name": "emitter-lib", "types": "./index.d.ts" }\n',
        "node_modules/emitter-lib/index.d.ts": `export ${declared}\n`,
        "main.ts": ['import { Emitter } from "emitter-lib";', ...lines, ""].join("\n"),
      }).filter((one) => one.includes("Events.")),
    ).toEqual(["DS1003 Events.open"]);
  });

  it("is read where a literal reaches an optional key parameter", () => {
    expect(
      memberFindings("Opt", [
        "declare function createStore<M>(): { get<K extends keyof M>(key?: K): M[K] };",
        "interface Opt { a: string; b: string }",
        'console.log(createStore<Opt>().get("a"));',
      ]),
    ).toEqual(["DS1003 Opt.b"]);
  });
});
