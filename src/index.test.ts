import { describe, expect, it } from "vitest";
import * as library from "./index.ts";

describe("the published index", () => {
  it("exports the command line, the vocabularies and the spelling helpers, and no stage of the analysis", () => {
    expect(Object.keys(library).sort()).toEqual([
      "CONTRACT_VERSION",
      "DECLINED_CONVENTIONS",
      "PositionError",
      "REF_EXPRESSIONS",
      "SETTING_OPTIONS",
      "byPosition",
      "computedComponent",
      "isRef",
      "nameComponent",
      "positionKey",
      "renderPosition",
      "renderRef",
      "run",
    ]);
  });
});
