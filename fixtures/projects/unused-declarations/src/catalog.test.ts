import {
  deprecatedTestedOnly,
  measure,
  onlyTested,
  testedByDeadTest,
  used,
} from "./catalog.ts";

// A test file under the default test-file pattern; a runner evaluates it as a module
// and calls neither test by name.

export function testOfDeadCode(): void {
  check(testedByDeadTest() + onlyTested(), 19);
}

export function testOfLiveCode(): void {
  check(used() + deprecatedTestedOnly() + measure({ size: 1 }), 10);
}

function check(got: number, want: number): void {
  if (got !== want) {
    throw new Error(`got ${String(got)}, want ${String(want)}`);
  }
}
