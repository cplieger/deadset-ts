/** One output stream of the command line. `process.stdout` and `process.stderr` satisfy it. */
export interface Writer {
  write(text: string): void;
}

const VERSION = "0.1.0-dev";

const CONTRACT_VERSION = "0.1.0";

const VERBS = [
  "analyze",
  "explain",
  "print-config",
  "print-roots",
  "print-retained",
  "describe",
  "version",
] as const;

const USAGE = `usage: deadset-ts <verb> [options]\nverbs: ${VERBS.join(", ")}\n`;

/**
 * Runs the deadset-ts command line over `args` (the arguments after the
 * program name) and returns the process exit code: 0 for a completed verb,
 * 2 for a usage error. It writes nothing outside `out` and `err` and never
 * exits the process, so a caller decides what the code means.
 *
 * Any `--fix` flag is refused before the verb is read: deadset-ts is
 * report-only and never edits source.
 */
export function run(args: readonly string[], out: Writer, err: Writer): number {
  const fix = args.find((arg) => arg === "--fix" || arg.startsWith("--fix="));
  if (fix !== undefined) {
    err.write(
      `deadset-ts: ${fix} is not supported: deadset-ts is report-only and never edits source\n`,
    );
    return 2;
  }
  const verb = args[0];
  if (verb === "version") {
    out.write(`deadset-ts ${VERSION}\ncontract ${CONTRACT_VERSION}\n`);
    return 0;
  }
  if (verb !== undefined) {
    err.write(`deadset-ts: unknown verb "${verb}"\n`);
  }
  err.write(USAGE);
  return 2;
}
