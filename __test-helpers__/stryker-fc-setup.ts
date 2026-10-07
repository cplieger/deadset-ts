// Mutation runs only (vitest.stryker.config.ts). A kill needs the first failure,
// not its shrunk counter-example: shrinking reruns a property whose every run
// analyzes a project, and that is time a killed mutant spends after it is killed.
import fc from "fast-check";

fc.configureGlobal({
  ...fc.readConfigureGlobal(),
  verbose: fc.VerbosityLevel.None,
  endOnFailure: true,
});
