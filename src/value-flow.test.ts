import { describe, expect, it } from "vitest";
import { isVariableDeclaration, type Expression, type Node } from "@typescript/native/ast";
import { openEngine } from "./session.ts";
import { handedOn, valuesOf } from "./value-flow.ts";

/** Each node of one module that hands an expression on, as `node: value | value`. */
function handedOnIn(text: string): string[] {
  const engine = openEngine({ collectTiming: false });
  try {
    const file = engine.parseSourceFile("/main.ts", text);
    const found: string[] = [];
    const visit = (node: Node): void => {
      const values = handedOn(node);
      if (values.length > 0) {
        found.push(`${node.getText()}: ${values.map((value) => value.getText()).join(" | ")}`);
      }
      node.forEachChild(visit);
    };
    file.forEachChild(visit);
    return found;
  } finally {
    engine.close();
  }
}

/** The values the initializer of the module's only declaration evaluates to. */
function valuesOfInitializer(text: string): string[] {
  const engine = openEngine({ collectTiming: false });
  try {
    const file = engine.parseSourceFile(
      "/main.ts",
      `declare const a: unknown, b: unknown, c: unknown;\nconst x = ${text};\n`,
    );
    let initializer: Expression | undefined;
    const visit = (node: Node): void => {
      if (isVariableDeclaration(node) && node.initializer !== undefined) {
        initializer = node.initializer;
      }
      node.forEachChild(visit);
    };
    file.forEachChild(visit);
    if (initializer === undefined) {
      throw new Error("no initializer");
    }
    return valuesOf(initializer).map((value) => value.getText());
  } finally {
    engine.close();
  }
}

describe("the values a written expression hands on", () => {
  it.each([
    ["a", ["a"]],
    ["(a)", ["a"]],
    ["c ? a : b", ["a", "b"]],
    ["a ?? b", ["a", "b"]],
    ["a || b", ["a", "b"]],
    ["a && b", ["b"]],
    ["(a, b)", ["b"]],
    ["(c ? a : b) ?? (c && a)", ["a", "b", "a"]],
    ["a + b", ["a + b"]],
    ["a === b", ["a === b"]],
  ])("of %s are %j", (text, values) => {
    expect(valuesOfInitializer(text)).toEqual(values);
  });
});

describe("the expressions a node hands to a position typed by its context", () => {
  it("are the initializer of a declaration that writes its type, and nothing of one that does not", () => {
    expect(
      handedOnIn(
        [
          "const typed: number = 1;",
          "const inferred = 2;",
          "class C {",
          "  typed: number = 3;",
          "  inferred = 4;",
          "}",
          "function f(typed: number = 5, inferred = 6): void {}",
        ].join("\n"),
      ),
    ).toEqual(["typed: number = 1: 1", "typed: number = 3;: 3", "typed: number = 5: 5"]);
  });

  it("are the right side of a storing assignment", () => {
    expect(handedOnIn("let a = 0;\na = 1;\na ??= 2;\na ||= 3;\na &&= 4;\na += 5;\n")).toEqual([
      "a = 1: 1",
      "a ??= 2: 2",
      "a ||= 3: 3",
      "a &&= 4: 4",
    ]);
  });

  it("are the arguments of a call or a construction that are not spread", () => {
    expect(
      handedOnIn(
        "declare function f(...a: unknown[]): void;\ndeclare const xs: unknown[];\nf(1, ...xs, 2);\nnew Map();\nnew Set([3]);\n",
      ),
    ).toEqual(["f(1, ...xs, 2): 1 | 2", "new Set([3]): [3]", "[3]: 3"]);
  });

  it("are a returned value and an arrow function's expression body, and nothing of a block body", () => {
    expect(
      handedOnIn(
        "function f(): number {\n  return 1;\n}\nfunction g(): void {\n  return;\n}\nconst h = () => 2;\nconst k = () => {};\n",
      ),
    ).toEqual(["return 1;: 1", "() => 2: 2"]);
  });

  it("are the elements of an array literal, past its spreads and holes", () => {
    expect(handedOnIn("declare const xs: number[];\nconst all = [1, ...xs, , 2];\n")).toEqual([
      "[1, ...xs, , 2]: 1 | 2",
    ]);
  });

  it("are the value of an object property, its own name for a shorthand one", () => {
    expect(handedOnIn("const b = 1;\nconst o = { a: 2, b };\n")).toEqual(["a: 2: 2", "b: b"]);
  });

  it("are the operand of `as` and of `satisfies`", () => {
    expect(handedOnIn("const a = 1 as number;\nconst b = 2 satisfies number;\n")).toEqual([
      "1 as number: 1",
      "2 satisfies number: 2",
    ]);
  });
});
