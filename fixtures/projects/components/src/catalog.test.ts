// A test file the default pattern classifies. Its functions reference the catalog, and
// nothing references them.

import { deadOne, deadTwo, live } from "./catalog.ts";

export function testDeadOnly(): void {
  assertSum(deadOne() + deadTwo(), 3);
}

export function testMixed(): void {
  assertSum(deadOne() + live(), 4);
}

function assertSum(got: number, want: number): void {
  if (got !== want) {
    throw new Error(`the sum is ${String(got)}, want ${String(want)}`);
  }
}
