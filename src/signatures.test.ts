import { describe, expect, it } from "vitest";
import { isIdentifier, type Node } from "@typescript/native/ast";
import { openEngine } from "./session.ts";
import { signatureOf } from "./signatures.ts";

function signaturesNamed(text: string, name: string): string[] {
  const engine = openEngine({ collectTiming: false });
  try {
    const file = engine.parseSourceFile("/main.ts", text);
    const found: string[] = [];
    const visit = (node: Node): void => {
      const named = (node as { readonly name?: Node }).name;
      if (named !== undefined && isIdentifier(named) && named.text === name) {
        const signature = signatureOf(node);
        const initializer = (node as { readonly initializer?: Node }).initializer;
        found.push(
          signature === undefined
            ? "none"
            : signature === node
              ? "itself"
              : signature === initializer
                ? "its initializer"
                : "another node",
        );
      }
      node.forEachChild(visit);
    };
    file.forEachChild(visit);
    return found;
  } finally {
    engine.close();
  }
}

describe("the function a declaration declares", () => {
  it("is a function declaration's own where it has a body, and none for an overload or an ambient one", () => {
    expect(
      signaturesNamed("function f(a: string): void;\nfunction f(a: unknown): void {}\n", "f"),
    ).toEqual(["none", "itself"]);
    expect(signaturesNamed("declare function g(): void;\n", "g")).toEqual(["none"]);
  });

  it("is a class method's own where it has a body, in a class declaration or expression", () => {
    expect(
      signaturesNamed(
        "abstract class C {\n  abstract m(): void;\n}\nclass D {\n  m(): void {}\n}\nconst E = class {\n  m(): void {}\n};\n",
        "m",
      ),
    ).toEqual(["none", "itself", "itself"]);
  });

  it("is none for an object literal's method, which no class declares", () => {
    expect(signaturesNamed("const o = {\n  m(): void {},\n};\n", "m")).toEqual(["none"]);
  });

  it("is the arrow or function expression a variable or a class property is initialized with", () => {
    expect(signaturesNamed("const a = () => 1;\n", "a")).toEqual(["its initializer"]);
    expect(signaturesNamed("const b = function () {\n  return 1;\n};\n", "b")).toEqual([
      "its initializer",
    ]);
    expect(signaturesNamed("const c = 1;\n", "c")).toEqual(["none"]);
    expect(signaturesNamed("let u;\n", "u")).toEqual(["none"]);
    expect(signaturesNamed("class K {\n  d = () => 1;\n  e = 1;\n}\n", "d")).toEqual([
      "its initializer",
    ]);
    expect(signaturesNamed("class K {\n  e = 1;\n}\n", "e")).toEqual(["none"]);
  });
});
