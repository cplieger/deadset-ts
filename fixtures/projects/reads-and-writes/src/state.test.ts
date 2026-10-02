import { shared } from "./state.ts";

// The only read of the variable, from a test file.
if (shared === 2) {
  throw new Error("the variable was never shared");
}
