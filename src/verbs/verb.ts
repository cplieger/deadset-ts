import type { Config, Inputs } from "../config.ts";
import type { Emitters } from "../findings/emitter.ts";
import type { Host } from "../host.ts";
import type { Writer } from "../run.ts";
import type { Scope } from "../scope.ts";
import type { Engine } from "../session.ts";

/** The exit codes the Contract's exit-code table names. */
export const EXIT_CLEAN = 0;
export const EXIT_FINDINGS = 1;
export const EXIT_USAGE = 2;
export const EXIT_FAILURE = 3;

/**
 * What one verb is handed: the streams it writes, the platform it reads, and the
 * options that follow its name, read only when the verb asks for what they name, so
 * a verb that asks for nothing refuses no option.
 */
export interface Invocation {
  readonly out: Writer;
  readonly err: Writer;
  readonly host: Host;
  /** The configuration documents the options name, and the settings they supply. */
  readonly inputs: () => Inputs;
  /** The scope the options name: the document `--scope` names, or the target. */
  readonly scope: () => Scope;
  /**
   * Opens the compiler client for a run under `config`. A client the verb opened is
   * closed if the verb throws.
   */
  readonly openClient: (config: Config) => Engine;
  /** The emitter of every kind family, which a verb that reports findings runs. */
  readonly emitters: Emitters;
  /** The arguments after the verb's name, as written. */
  readonly args: readonly string[];
  /** The last value one of the verb's own options was given, undefined where none was. */
  readonly option: (name: string) => string | undefined;
  /** Every value a repeatable option of the verb was given, in the order they were written. */
  readonly repeated: (name: string) => readonly string[];
}

/** The options one verb takes beside the ones every verb takes, each taking a value. */
export interface VerbOptions {
  readonly plain: readonly string[];
  /** The options that may be written more than once, each occurrence one value. */
  readonly repeatable: readonly string[];
}

/**
 * One verb of the command line. It returns the exit code, and refuses by throwing a
 * configuration, discovery or scope error, which the command line writes and turns
 * into the code the Contract's table gives it.
 */
export type Verb = (invocation: Invocation) => number;
