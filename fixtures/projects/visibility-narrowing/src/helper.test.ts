// A test file, whose references a production sweep does not count.

import { testedOnly } from "./helper.ts";

if (testedOnly() === "") {
  throw new Error("the helper returned an empty string");
}

// A test whose every subject is dead.
export function checksTestedOnly(): boolean {
  return testedOnly() === "tested";
}
