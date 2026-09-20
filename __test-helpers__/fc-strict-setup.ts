// Strict global fast-check defaults, loaded via vitest setupFiles.
//
// numRuns 1000: 10x default, still <1s per property at typical <100ms runtime.
// interruptAfterTimeLimit 10s: bounds a pathological generator.
// markInterruptAsFailure: an interrupt must fail CI, not pass silently.
// endOnFailure false: always shrink to the minimal counter-example.
// No fixed seed: a newly-discovered counter-example is a bug report, not flake.

import fc from "fast-check";

fc.configureGlobal({
  numRuns: 1000,
  verbose: fc.VerbosityLevel.VeryVerbose,
  endOnFailure: false,
  interruptAfterTimeLimit: 10000,
  markInterruptAsFailure: true,
});
