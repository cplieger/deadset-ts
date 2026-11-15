import { describe, expect, it } from "vitest";
import { unmatchedRootFindings } from "./self-check.ts";

describe("a configured root that matches nothing", () => {
  it("is called a pattern where it holds a star or a question mark, and a root otherwise", () => {
    expect(
      unmatchedRootFindings(
        [
          "ts://@example/app/src/main.ts#start",
          "ts://@example/app/src/*.ts#run",
          "ts://@example/app/src/main.ts#run?",
        ],
        "",
      ).map((finding) => `${finding.symbol.name}: ${finding.message}`),
    ).toEqual([
      "ts://@example/app/src/main.ts#start: configured root ts://@example/app/src/main.ts#start matches no symbol of the inventory",
      "ts://@example/app/src/*.ts#run: configured root pattern ts://@example/app/src/*.ts#run matches no symbol of the inventory",
      "ts://@example/app/src/main.ts#run?: configured root pattern ts://@example/app/src/main.ts#run? matches no symbol of the inventory",
    ]);
  });
});
