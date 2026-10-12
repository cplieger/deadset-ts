import { describe, expect, it } from "vitest";
import { analyzeProject, type AnalyzeOptions } from "../__test-helpers__/projects.ts";

/** A dependency declaring one class with an instance and a static member. */
const DEPENDENCY = {
  "node_modules/base-pkg/package.json":
    '{ "name": "base-pkg", "version": "1.0.0", "types": "./index.d.ts" }\n',
  "node_modules/base-pkg/index.d.ts":
    "export declare class Base {\n  run(): void;\n  static make(): Base;\n}\n",
};

/** One module's text, a line per argument. */
function lines(...text: readonly string[]): string {
  return `${text.join("\n")}\n`;
}

/** Each override reference of one written project, as the names it joins. */
function overridesOf(
  files: Readonly<Record<string, string>>,
  panicsOn?: AnalyzeOptions["panicsOn"],
): string[] {
  const analyzed = analyzeProject(
    { ...DEPENDENCY, ...files },
    { references: { testFiles: [] }, ...(panicsOn === undefined ? {} : { panicsOn }) },
  );
  const symbols = analyzed.inventories[0]?.symbols ?? [];
  const name = (id: string): string => symbols.find((symbol) => symbol.id === id)?.name ?? id;
  return (analyzed.references[0]?.references ?? [])
    .filter((reference) => reference.resolution === "override")
    .map((reference) => `${name(reference.from)} -> ${name(reference.to)}`);
}

describe("the overrides of a class the target declares", () => {
  it("are referenced from the base member, for a subclass nested in a namespace", () => {
    expect(
      overridesOf({
        "src/main.ts": lines(
          "class Base {",
          "  m(): void {}",
          "}",
          "export namespace N {",
          "  export class C extends Base {",
          "    override m(): void {}",
          "  }",
          "}",
          "new N.C().m();",
        ),
      }),
    ).toEqual(["Base.m -> N.C.m"]);
  });

  it("are referenced from the nearest base declaring the member, through a class between", () => {
    expect(
      overridesOf({
        "src/main.ts": lines(
          "class Base {",
          "  m(): void {}",
          "}",
          "class Mid extends Base {}",
          "export class C extends Mid {",
          "  override m(): void {}",
          "}",
          "const b: Base = new C();",
          "b.m();",
        ),
      }),
    ).toEqual(["Base.m -> C.m"]);
  });

  it("are not read for a class a class only implements", () => {
    expect(
      overridesOf({
        "src/main.ts": lines(
          "class Base {",
          "  m(): void {}",
          "}",
          "export class C implements Base {",
          "  m(): void {}",
          "}",
          "console.log(new C(), new Base());",
        ),
      }),
    ).toEqual([]);
  });

  it("are not read for a private member", () => {
    expect(
      overridesOf({
        "src/main.ts": lines(
          "class A {",
          "  private m(): void {}",
          "}",
          "export class B extends A {",
          "  private m(): void {}",
          "}",
          "console.log(new B(), new A());",
        ),
      }),
    ).toEqual([]);
  });

  it("end where an extends chain runs in a circle", () => {
    expect(
      overridesOf({
        "src/main.ts": lines(
          "class A extends B {",
          "  m(): void {}",
          "}",
          "class B extends A {}",
          "export class C extends A {",
          "  m(): void {}",
          "  n(): void {}",
          "}",
          "console.log(new C());",
        ),
      }),
    ).toEqual(["A.m -> C.m"]);
  });

  it("are read against the target's class of the same name where an imported base's step goes unanswered", () => {
    expect(
      overridesOf(
        {
          "src/other.ts": lines("export class Base {", "  run(): void {}", "}"),
          "src/main.ts": lines(
            'import { Base } from "base-pkg";',
            "export class C extends Base {",
            "  run(): void {}",
            "}",
            "console.log(new C());",
          ),
        },
        (accessor) => accessor === "getImmediateAliasedSymbol",
      ),
    ).toEqual(["Base.run -> C.run"]);
  });
});

describe("the overrides of a class a dependency declares", () => {
  it("are referenced from the overriding class, a static member's included", () => {
    expect(
      overridesOf({
        "src/main.ts": lines(
          'import { Base } from "base-pkg";',
          "export class C extends Base {",
          "  run(): void {}",
          "  own(): void {}",
          "  static make(): C {",
          "    return new C();",
          "  }",
          "}",
          "new C();",
        ),
      }),
    ).toEqual(["C -> C.run", "C -> C.make"]);
  });

  it("are read through a re-export the target writes", () => {
    expect(
      overridesOf({
        "src/again.ts": 'export { Base } from "base-pkg";\n',
        "src/main.ts": lines(
          'import { Base } from "./again.ts";',
          "export class C extends Base {",
          "  run(): void {}",
          "  own(): void {}",
          "}",
          "new C();",
        ),
      }),
    ).toEqual(["C -> C.run"]);
  });

  it("are read through a class of the target between", () => {
    expect(
      overridesOf({
        "src/main.ts": lines(
          'import { Base } from "base-pkg";',
          "class Mid extends Base {}",
          "export class Leaf extends Mid {",
          "  run(): void {}",
          "  own(): void {}",
          "}",
          "console.log(new Leaf());",
        ),
      }),
    ).toEqual(["Leaf -> Leaf.run"]);
  });

  it("are not read for a base that is a value with a constructor type rather than a class", () => {
    expect(
      overridesOf({
        "src/main.ts": lines(
          "export class E extends Error {",
          '  override message = "x";',
          "}",
          "console.log(new E());",
        ),
      }),
    ).toEqual([]);
  });
});
