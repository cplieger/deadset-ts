import { describe } from "vitest";
import { GRAMMAR_FILES, grammarCases } from "../../__test-helpers__/named-files.ts";

describe("spelledFiles", () => {
  grammarCases(GRAMMAR_FILES.slice(8));
});
