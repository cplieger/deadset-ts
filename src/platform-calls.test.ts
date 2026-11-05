import { describe, expect, it } from "vitest";
import { isCallExpression, isIdentifier, type Identifier, type Node } from "@typescript/native/ast";
import { declarationOf } from "./entries/static-module.ts";
import { callsPlatformBy, lexicalBinding, writtenName } from "./platform-calls.ts";
import { openEngine } from "./session.ts";

const engine = openEngine({ collectTiming: false });

/** Every identifier of `text`, read as a module, written as `name`. */
function written(text: string, name: string): readonly Identifier[] {
  const found: Identifier[] = [];
  const visit = (node: Node): void => {
    if (isIdentifier(node) && node.text === name) {
      found.push(node);
    }
    node.forEachChild(visit);
  };
  visit(engine.parseSourceFile("/project/x.mjs", text));
  return found;
}

/** Whether each call of `text`, read with no checker, is a `require()` call, in source order. */
function requires(text: string): readonly boolean[] {
  const found: boolean[] = [];
  const binding = lexicalBinding(declarationOf);
  const visit = (node: Node): void => {
    if (isCallExpression(node)) {
      const callee = writtenName(node.expression);
      found.push(callee !== undefined && callsPlatformBy("require", callee, binding));
    }
    node.forEachChild(visit);
  };
  visit(engine.parseSourceFile("/project/x.cjs", text));
  return found;
}

describe("a written name's binding by the file's own scopes", () => {
  const binding = lexicalBinding(declarationOf);

  it("binds no property, which is read by how it is written", () => {
    expect(written("module.require;\nother.require;\n", "require").map(binding)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("names an import specifier and a destructured property by the name each carries, proving nothing", () => {
    const [, make] = written(
      'import { createRequire as make } from "node:module";\nmake(import.meta.url);\n',
      "make",
    );
    const [, take] = written(
      'const { createRequire: take } = require("module");\ntake(1);\n',
      "take",
    );

    expect(make === undefined ? undefined : binding(make)).toMatchObject({
      names: new Set(["make", "createRequire"]),
      provenOwn: false,
    });
    expect(take === undefined ? undefined : binding(take)).toMatchObject({
      names: new Set(["take", "createRequire"]),
      provenOwn: false,
    });
  });
});

describe("a require() call read with no checker", () => {
  it("is every call of a name or a member written require, a function the file writes included", () => {
    expect(
      requires(
        [
          'require("a");',
          'module.require("b");',
          'other.require("c");',
          "function require(id) {\n  return id;\n}",
          'load("d");',
          "",
        ].join("\n"),
      ),
    ).toEqual([true, true, true, false]);
  });

  it("is a call of what a createRequire returns, under any name, through each variable that holds it", () => {
    expect(
      requires(
        [
          'const { createRequire: make } = require("module");',
          "const build = make;",
          "const load = build(__filename);",
          "const again = load;",
          'again("a");',
          "const plain = other(__filename);",
          'plain("b");',
          "",
        ].join("\n"),
      ),
    ).toEqual([true, false, true, false, false]);
  });
});
