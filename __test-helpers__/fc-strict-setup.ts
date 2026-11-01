// Strict global fast-check defaults, loaded via vitest setupFiles.
//
// numRuns 1000: 10x default, still <1s per property at typical <100ms runtime.
// interruptAfterTimeLimit 10s with failOnInterrupt: bounds a pathological generator,
// and an interrupt fails CI rather than passing silently. A call that passes its own
// `plugins` replaces this list, so it restates failOnInterrupt.
// endOnFailure false: always shrink to the minimal counter-example.
// No fixed seed: a newly-discovered counter-example is a bug report, not flake.

import fc from "fast-check";

fc.configureGlobal({
  numRuns: 1000,
  verbose: fc.VerbosityLevel.VeryVerbose,
  endOnFailure: false,
  plugins: [fc.interruptAfterTimeLimit(10000, { failOnInterrupt: true })],
});
