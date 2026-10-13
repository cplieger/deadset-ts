import { describe, expect, it } from "vitest";
import { treeFindings } from "../__test-helpers__/tree-findings.ts";

describe("a member read through a value typed by a type parameter", () => {
  it("reads the member of that name on the type each call passes for the parameter", () => {
    expect(
      treeFindings({
        "main.ts": [
          "interface Base { readonly kind: string }",
          "interface Action extends Base { readonly kind: string; readonly expects: string; readonly spare: string }",
          "interface Other { readonly kind: string; readonly unread: string }",
          "function describeIt<T extends Base>(value: T): string { return value.kind; }",
          "function kindOf<T extends Base>(values: readonly T[]): string { return values.map((one) => one.kind).join(); }",
          'const action: Action = { kind: "a", expects: "e", spare: "s" };',
          'const other: Other = { kind: "o", unread: "u" };',
          "console.log(describeIt(action), kindOf([other]), action.expects);",
          "",
        ].join("\n"),
      }),
    ).toEqual(["DS1301 Action.spare", "DS1301 Other.unread"]);
  });
});
