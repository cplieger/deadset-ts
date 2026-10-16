import { LANGUAGE_ROWS } from "./contract/contract.generated.ts";
import type { Writer } from "./run.ts";

/** The language this analyzer reads. */
export const LANGUAGE = "ts";

/** The analyzer's name: the one its language's row names, which every output spells it with. */
export const PRODUCT = LANGUAGE_ROWS[LANGUAGE].analyzer;

/** Writes one diagnostic line to the error stream, named for the analyzer. */
export function diagnose(err: Writer, text: string): void {
  err.write(`${PRODUCT}: ${text}\n`);
}

/** The text one thrown value carries. */
export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
