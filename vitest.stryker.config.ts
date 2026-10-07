import { relative } from "node:path";
import { defineConfig, mergeConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import base from "./vitest.config.ts";

// Under Stryker's bail a killed mutant stops at its first failing file, and vitest's
// default longest-first order makes it pay for the whole-project suites before the
// cheap unit test that kills it.
class CheapestFirst extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const root = this.ctx.config.root;
    const rank = (spec: TestSpecification): [number, number] => {
      const state = this.ctx.cache.getFileTestResults(
        `${spec.project.name}:${relative(root, spec.moduleId)}`,
      );
      return [state?.failed === true ? 0 : 1, state?.duration ?? 0];
    };
    const ordered = await super.sort(files);
    return ordered.sort((a, b) => {
      const [failedA, durationA] = rank(a);
      const [failedB, durationB] = rank(b);
      return failedA - failedB || durationA - durationB;
    });
  }
}

// Mutation runs only: Stryker's instrumentation slows the property and corpus suites
// past the 5s default, so the dry run fails before any mutant runs. Stryker's own
// timeoutMS and timeoutFactor still bound each mutant.
export default mergeConfig(
  base,
  defineConfig({
    test: {
      testTimeout: 60_000,
      setupFiles: ["./__test-helpers__/stryker-fc-setup.ts"],
      sequence: { sequencer: CheapestFirst },
    },
  }),
);
