import { describe, expect, it } from "vitest";
import { treeFindings } from "../__test-helpers__/tree-findings.ts";

/** A dependency declaring a typed bus whose methods are function-typed properties. */
const BUS = {
  "node_modules/@example/bus/package.json": JSON.stringify({
    name: "@example/bus",
    version: "1.0.0",
    types: "index.d.ts",
  }),
  "node_modules/@example/bus/index.d.ts": [
    "export interface Bus<M> {",
    "  on: <K extends keyof M>(event: K, handler: (payload: M[K]) => void) => () => void;",
    "  emit: <K extends keyof M>(event: K, ...payload: M[K] extends undefined ? [] : [M[K]]) => void;",
    "  has<K extends Extract<keyof M, string>>(event: K): boolean;",
    "}",
    "export declare function createBus<M>(): Bus<M>;",
    "",
  ].join("\n"),
};

describe("a member of a map type a call fixes the key of", () => {
  it("is read through a method aliased off the instance, a computed key and a const key", () => {
    const found = treeFindings({
      ...BUS,
      "bus.ts": [
        'import { createBus } from "@example/bus";',
        'export const OPENED = "opened" as const;',
        'export const CLOSED = "closed" as const;',
        "interface Payloads {",
        "  readonly [OPENED]: string;",
        "  readonly [CLOSED]: undefined;",
        "  readonly dropped: number;",
        "  readonly asked: boolean;",
        "}",
        "const bus = createBus<Payloads>();",
        "export const onBus = bus.on;",
        "export const emitBus = bus.emit;",
        "export const { has } = bus;",
        "",
      ].join("\n"),
      "main.ts": [
        'import { CLOSED, OPENED, emitBus, has, onBus } from "./bus.js";',
        'emitBus(OPENED, "x");',
        "onBus(CLOSED, () => undefined);",
        'export const asked = has("asked");',
        "",
      ].join("\n"),
    });

    expect(found.filter((one) => one.includes("Payloads."))).toEqual(["DS1003 Payloads.dropped"]);
  });

  it("is read where a type parameter constrained to a subset of its keys indexes it", () => {
    const found = treeFindings({
      "main.ts": [
        'type Kind = "a" | "b";',
        "interface Payload { a: string; b: number; c: boolean }",
        "export function payloadOf<K extends Kind>(map: Payload, kind: K): Payload[K] {",
        "  return map[kind];",
        "}",
        'export const got = payloadOf({ a: "x", b: 1, c: true }, "a");',
        "",
      ].join("\n"),
    });

    expect(found.filter((one) => one.includes("Payload."))).toEqual(["DS1301 Payload.c"]);
  });

  it("is read through each instantiation a mapped type over a key union makes", () => {
    const found = treeFindings({
      "main.ts": [
        'type Kind = "a" | "b";',
        "interface Payload { a: string; b: number; c: boolean }",
        "type Kinded<K extends Kind> = { kind: K; payload: Payload[K] };",
        "type AnyKinded = { [K in Kind]: Kinded<K> }[Kind];",
        'const one: AnyKinded = { kind: "a", payload: "x" };',
        "console.log(one.kind);",
        "",
      ].join("\n"),
    });

    expect(found.filter((one) => one.includes("Payload."))).toEqual(["DS1003 Payload.c"]);
  });

  it("is read where a call passes a literal to a parameter typed by keyof of the receiver's argument", () => {
    const found = treeFindings({
      "node_modules/@example/signals/package.json": JSON.stringify({
        name: "@example/signals",
        version: "1.0.0",
        types: "index.d.ts",
      }),
      "node_modules/@example/signals/index.d.ts":
        "export interface Signals<M> {\n  clear(event?: keyof M): void;\n}\nexport declare function signals<M>(): Signals<M>;\n",
      "main.ts": [
        'import { signals } from "@example/signals";',
        "interface Events { closed: string; opened: string }",
        'signals<Events>().clear("closed");',
        "",
      ].join("\n"),
    });

    expect(found.filter((one) => one.includes("Events."))).toEqual(["DS1003 Events.opened"]);
  });

  it("is read through a method of a type literal a generic function returns, destructured or not", () => {
    const found = treeFindings({
      "main.ts": [
        "declare function createStore<M>(): { get<K extends keyof M>(key: K): M[K] };",
        "interface ByMember { viaMember: string; unread: string }",
        "interface ByDestructure { viaDestructure: string }",
        "const member = createStore<ByMember>();",
        'export const a = member.get("viaMember");',
        "export const { get } = createStore<ByDestructure>();",
        'export const b = get("viaDestructure");',
        "",
      ].join("\n"),
    });

    expect(found.filter((one) => /ByMember|ByDestructure/u.test(one))).toEqual([
      "DS1003 ByMember.unread",
    ]);
  });
});
