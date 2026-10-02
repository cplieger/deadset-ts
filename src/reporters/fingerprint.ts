import { sha256Hex } from "./sha256.ts";

/** The unit appended after the last unit of a file. */
const SENTINEL = 0xffffn;

/** The number of significant units one line's hash covers. */
const WINDOW = 100;

const FACTOR = 37n;

/** Arithmetic is unsigned 64-bit with wraparound. */
const MASK = (1n << 64n) - 1n;

const SPACE = 0x20;
const TAB = 0x09;
const CR = 0x0d;
const LF = 0x0a;

/**
 * The units of one file the line fingerprint counts: every UTF-16 code unit but a space or
 * a tab, a carriage return read as a line feed and the line feed following it dropped, then
 * the sentinel.
 */
function significantUnits(text: string): bigint[] {
  const kept: bigint[] = [];
  let afterCR = false;
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit === SPACE || unit === TAB || (afterCR && unit === LF)) {
      afterCR = false;
      continue;
    }
    afterCR = unit === CR;
    kept.push(BigInt(afterCR ? LF : unit));
  }
  kept.push(SENTINEL);
  return kept;
}

/**
 * The line fingerprint of every line of one file, indexed from zero. The procedure is the one
 * a code-scanning service computes for a result that carries none, followed exactly, because
 * a value that differs from the service's opens a second alert for one finding.
 */
export function lineHashes(text: string): readonly string[] {
  const units = significantUnits(text);
  const starts = [0];
  for (let i = 0; i < units.length - 1; i += 1) {
    if (units[i] === BigInt(LF)) {
      starts.push(i + 1);
    }
  }
  const seen = new Map<string, number>();
  return starts.map((start) => {
    let hash = 0n;
    for (let i = start; i < start + WINDOW; i += 1) {
      hash = (hash * FACTOR + (units[i] ?? 0n)) & MASK;
    }
    const rendered = hash.toString(16);
    const count = (seen.get(rendered) ?? 0) + 1;
    seen.set(rendered, count);
    return `${rendered}:${String(count)}`;
  });
}

/** The key a baseline joins on, which a line move leaves unchanged. */
export function symbolFingerprint(code: string, ref: string): string {
  return sha256Hex(`${code}\n${ref}`);
}
