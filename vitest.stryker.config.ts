import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.ts";

// Mutation runs only: Stryker's instrumentation slows the property and corpus suites
// past the 5s default, so the dry run fails before any mutant runs. Stryker's own
// timeoutMS and timeoutFactor still bound each mutant.
export default mergeConfig(base, defineConfig({ test: { testTimeout: 60_000 } }));
