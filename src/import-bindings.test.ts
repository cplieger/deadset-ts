import { describe, expect, it } from "vitest";
import { bindingsOf, importedNames } from "./import-bindings.ts";
import { openEngine } from "./session.ts";

const engine = openEngine({ collectTiming: false });

/** The names each top-level statement of `text` reads from the module it names. */
function imported(text: string): readonly (readonly (string | undefined)[])[] {
  return engine.parseSourceFile("/project/x.ts", text).statements.map(importedNames);
}

describe("the export names an import or a re-export reads", () => {
  it.each([
    { text: 'import "./a";', names: [] },
    { text: 'import a from "./a";', names: ["default"] },
    { text: 'import * as a from "./a";', names: [undefined] },
    { text: 'import a, * as b from "./a";', names: ["default", undefined] },
    { text: 'import a, { b, c as d } from "./a";', names: ["default", "b", "c"] },
    { text: 'import { "a-b" as c } from "./a";', names: ["a-b"] },
    { text: 'export * from "./a";', names: [undefined] },
    { text: 'export * as a from "./a";', names: [undefined] },
    { text: 'export { a, b as c } from "./a";', names: ["a", "b"] },
    { text: 'import a = require("./a");', names: [] },
    { text: "const a = 1;", names: [] },
  ])("are $names for $text", ({ text, names }) => {
    expect(imported(text)).toEqual([names]);
  });

  it("are the names the file's own import bindings carry", () => {
    const file = engine.parseSourceFile(
      "/project/x.ts",
      'import a, { b as c } from "./a";\nimport * as d from "./d";\n',
    );

    expect(bindingsOf(file).map((binding) => [binding.name.text, binding.imported])).toEqual([
      ["a", "default"],
      ["c", "b"],
      ["d", undefined],
    ]);
    expect(file.statements.flatMap(importedNames)).toEqual(["default", "b", undefined]);
  });
});
