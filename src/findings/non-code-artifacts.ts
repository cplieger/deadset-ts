import { CODE } from "../contract/contract.generated.ts";
import type { ResolvedConfig } from "../config.ts";
import type { Finding } from "../finding.ts";
import { displayName } from "../inventory.ts";
import type { Emitter, EmitterInput } from "./emitter.ts";
import { subjectsOf } from "./subjects.ts";

/** The subject kind of a finding about a source file, from the finding schema's vocabulary. */
const FILE_SUBJECT = "file";

/** A file's subject starts at its first character. */
const FILE_START = 1;

/**
 * Whether the configuration declares the run's matrix complete. The declaration is
 * about the projects the configuration lists, so a configuration declaring
 * completeness and listing no project declares it of a matrix the run derived, and a
 * derived matrix is never complete.
 */
function completeMatrix(config: ResolvedConfig): boolean {
  return (
    config.analysis.matrix.complete &&
    config.analysis.configurations.some((entry) => "project" in entry)
  );
}

/** One finding about a whole file, whose message `says` names the file by its name. */
function fileFinding(
  code: string,
  file: { readonly path: string; readonly ref: string; readonly endLine: number },
  says: (name: string) => string,
): Finding {
  const name = displayName(file.path);
  return {
    code,
    position: { path: file.path, line: FILE_START, column: FILE_START, endLine: file.endLine },
    symbol: { ref: file.ref, kind: FILE_SUBJECT, name, sizeLines: file.endLine },
    message: says(name),
  };
}

/**
 * Every source file below the target root that no project of the matrix includes,
 * under a matrix the configuration declares complete: that declaration says the listed
 * projects are every one the target builds, so a file none of them includes is built
 * by nothing. Under a derived matrix nothing is reported, because a project the
 * derivation did not find is no evidence that nothing builds the file.
 */
function fileNeverBuilt({ config, swept, files }: EmitterInput): readonly Finding[] {
  if (!completeMatrix(config)) {
    return [];
  }
  const built = new Set(
    swept.matrix.union.symbols
      .filter((symbol) => symbol.kind === FILE_SUBJECT)
      .map((symbol) => symbol.position.path),
  );
  const configurations = swept.matrix.configurations.join(", ");
  return files.tree
    .filter((file) => !built.has(file.path))
    .map((file) =>
      fileFinding(
        CODE.fileNeverBuilt,
        file,
        (name) => `no project of the build matrix includes file ${name} (${configurations})`,
      ),
    );
}

/**
 * Every file of the run that no reference from live code reaches and no root or edge
 * names. A file only dead code imports is found dead under reachability alone.
 */
function fileNeverImported(input: EmitterInput): readonly Finding[] {
  const { kept, referenced } = subjectsOf(input).files();
  return input.swept.matrix.union.symbols
    .filter((symbol) => symbol.kind === FILE_SUBJECT && !kept.has(symbol.position.path))
    .map((symbol) => {
      const file = { path: symbol.position.path, ref: symbol.ref, endLine: symbol.endLine };
      return referenced.has(symbol.position.path)
        ? {
            ...fileFinding(
              CODE.fileNeverImported,
              file,
              (name) =>
                `only code that is itself dead imports file ${name}, and no root names it or a declaration in it`,
            ),
            unreachableOnly: true as const,
          }
        : fileFinding(
            CODE.fileNeverImported,
            file,
            (name) => `no import reaches file ${name} and no root names it or a declaration in it`,
          );
    });
}

/**
 * The findings of the files family, `DS1600` to `DS1699`, each at the class `possible` in a
 * package a command of which may run a file whose path no word of it writes, since that
 * command may run the file (confidence.35).
 */
export const nonCodeArtifacts: Emitter = (input) => {
  const unwritten = [...(input.files.unwrittenRuns ?? [])];
  return [...fileNeverBuilt(input), ...fileNeverImported(input)].map((finding) =>
    unwritten.some(
      (dir) =>
        dir === "." || finding.position.path === dir || finding.position.path.startsWith(`${dir}/`),
    )
      ? { ...finding, reachabilityClass: "possible" as const }
      : finding,
  );
};
