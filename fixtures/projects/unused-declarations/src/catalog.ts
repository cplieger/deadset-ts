// Every declaration below that the entry file does not reach carries one expectation.

export function used(): number {
  return usedHelper();
}

function usedHelper(): number {
  return 1;
}

// Nothing names it: an exported function nothing references.
export function unusedExported(): number {
  return 2;
}

// Nothing names it: a declaration the module does not export.
function unusedUnexported(): number {
  return 3;
}

// Its only reference is its own recursive call.
export function recurse(n: number): number {
  return n <= 0 ? 0 : recurse(n - 1);
}

// A dead root and the helper that falls with it.
export function deadCaller(): number {
  return calledOnlyByDead();
}

function calledOnlyByDead(): number {
  return 4;
}

// A dead class: the class is reported and its members fall with it.
export class Obsolete {
  value = 0;

  describe(): string {
    return String(this.value);
  }
}

export class Counter {
  live: number;

  private stale?: number;

  #origin?: string;

  protected guarded?: number;

  static created = 0;

  /**
   * The count an earlier constructor kept.
   *
   * @deprecated nothing reads it.
   */
  legacy?: number;

  constructor(live: number) {
    this.live = live;
  }

  total(): number {
    return this.live;
  }

  unusedMethod(): number {
    return 5;
  }
}

export interface Labelled {
  label: string;
  /** Read and written by nothing. */
  note?: string;
}

export type Measured = {
  readonly size: number;
  readonly unit?: string;
};

export enum Color {
  Red,
  Green,
  Blue,
}

// Reads one enum member, and nothing reads this function.
export function deadColorReader(): Color {
  return Color.Green;
}

export namespace Shapes {
  export const area = 1;
  export const unusedArea = 2;
  const hidden = 3;
}

export const Settings = { width: 1 };

// A re-export nothing imports.
export { used as alias };

/**
 * Replaced by used.
 *
 * @deprecated nothing references it.
 */
export function deprecatedUnused(): number {
  return 6;
}

/**
 * Deprecated in a declaration that names two variables, so the tag covers both.
 *
 * @deprecated nothing reads either of them.
 */
export const staleFirst = 1,
  staleSecond = 2;

/**
 * Replaced by used, and the entry file still calls it.
 *
 * @deprecated the entry file references it.
 */
export function deprecatedButUsed(): number {
  return 7;
}

/**
 * Referenced from a test file alone.
 *
 * @deprecated the test file references it.
 */
export function deprecatedTestedOnly(): number {
  return 8;
}

// Referenced from a test file alone.
export function onlyTested(): number {
  return 9;
}

// Referenced from a test file alone, and the one test referencing it references
// nothing live.
export function testedByDeadTest(): number {
  return 10;
}

export function measure(value: Measured): number {
  return value.size;
}
