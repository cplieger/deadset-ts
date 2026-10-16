/**
 * A refusal of the invocation: the fix is to the command line or to a document it
 * names, so the run ends with the usage code before any analysis.
 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}
