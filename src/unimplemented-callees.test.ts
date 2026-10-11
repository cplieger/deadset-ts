import { describe, expect, it } from "vitest";
import { treeFindings } from "../__test-helpers__/tree-findings.ts";

describe("an object literal handed to a callee the target does not implement", () => {
  it("has every member of the parameter type it is checked against read", () => {
    const found = treeFindings({
      "globals.d.ts":
        "interface Init { subject: string; body: string }\ndeclare function notify(init: Init): void;\n",
      "main.ts": 'notify({ subject: "s", body: "b" });\n',
    });

    expect(found.filter((one) => one.includes("Init."))).toEqual([]);
  });

  it("is read only as the target's own callee reads it, where one stands for the signature", () => {
    const found = treeFindings({
      "main.ts": [
        "interface Login { id: string; password: string }",
        "function login(init: Login): string {",
        "  return init.id;",
        "}",
        'export const done = login({ id: "i", password: "p" });',
        "",
      ].join("\n"),
    });

    expect(found.filter((one) => one.includes("Login."))).toEqual(["DS1301 Login.password"]);
  });

  it("is read only as a callback of the target reads it, where the callback reaches the parameter called", () => {
    const found = treeFindings({
      "main.ts": [
        "interface Init { used: string; extra: string }",
        "interface Named { kept: string; spare: string }",
        "interface Unseen { first: string; second: string }",
        "function invoke(callback: (init: Init) => string): string {",
        '  return callback({ used: "u", extra: "e" });',
        "}",
        "const readKept = (named: Named): string => named.kept;",
        "function relay(callback: (named: Named) => string): string {",
        '  return callback({ kept: "k", spare: "s" });',
        "}",
        "export function open(callback: (unseen: Unseen) => string): string {",
        '  return callback({ first: "f", second: "s" });',
        "}",
        "export const done = invoke((init) => init.used) + relay(readKept);",
        "",
      ].join("\n"),
    });

    expect(found.filter((one) => /Init\.|Named\.|Unseen\./u.test(one))).toEqual([
      "DS1301 Init.extra",
      "DS1301 Named.spare",
    ]);
  });
});

describe("a value the target receives from code it cannot see", () => {
  it("has every member of the type an assertion over a platform object gives it read", () => {
    const found = treeFindings({
      "main.ts": [
        "interface Scope { onconnect: ((event: MessageEvent) => void) | null }",
        "(globalThis as unknown as Scope).onconnect = (event) => {",
        "  console.log(event.data);",
        "};",
        "",
      ].join("\n"),
    });

    expect(found.filter((one) => one.includes("Scope."))).toEqual([]);
  });

  it("has every member of the type a construct signature with no implementation names read", () => {
    const found = treeFindings({
      "main.ts": [
        "interface Shown { onclick: (() => void) | null }",
        "interface ShownCtor { new (title: string): Shown }",
        "interface Env { readonly ctor: ShownCtor }",
        "export function show(env: Env): void {",
        '  const posted = new env.ctor("t");',
        "  posted.onclick = () => undefined;",
        "}",
        "",
      ].join("\n"),
    });

    expect(found.filter((one) => one.includes("Shown."))).toEqual([]);
  });

  it("leaves a member of a type an assertion over a decoded value gives it unread", () => {
    const found = treeFindings({
      "main.ts": [
        "interface Decoded { kept: string; left: string }",
        "const value = JSON.parse('{}') as Decoded;",
        "value.left = value.kept;",
        "",
      ].join("\n"),
    });

    expect(found.filter((one) => one.includes("Decoded."))).toEqual(["DS1301 Decoded.left"]);
  });
});
