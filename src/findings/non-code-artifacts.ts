import type { Config } from "../config.ts";
import type { Finding } from "../finding.ts";
import type { Graph } from "../graph.ts";
import type { Emitter, EmitterInput } from "./emitter.ts";

const FILE_NEVER_BUILT = "DS1501";
const FILE_NEVER_IMPORTED = "DS1502";

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
function completeMatrix(config: Config): boolean {
  return (
    config.analysis.matrixComplete &&
    config.analysis.configurations.some((entry) => entry.shape === "project")
  );
}

/** One finding about a whole file. */
function fileFinding(
  code: string,
  file: { readonly path: string; readonly ref: string; readonly endLine: number },
  message: string,
): Finding {
  return {
    code,
    position: { path: file.path, line: FILE_START, column: FILE_START, endLine: file.endLine },
    symbol: { ref: file.ref, kind: FILE_SUBJECT, name: file.path, sizeLines: file.endLine },
    message,
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
  const message = `no project of the build matrix includes this file (${swept.matrix.configurations.join(", ")})`;
  return files.tree
    .filter((file) => !built.has(file.path))
    .map((file) => fileFinding(FILE_NEVER_BUILT, file, message));
}

/**
 * The paths of every file a reference written in another file reaches, naming the
 * file or a declaration in it, a loaded consumer's file included. An import is such a
 * reference, so an import from any file reaches what it names, whatever reaches the
 * importing file.
 */
function reachedFromOutside(union: Graph): ReadonlySet<string> {
  const reached = new Set<string>();
  for (const edge of union.consumed) {
    const to = union.symbols[edge.to];
    if (to !== undefined) {
      reached.add(to.position.path);
    }
  }
  union.out.forEach((edges, from) => {
    const fromPath = union.symbols[from]?.position.path;
    for (const edge of edges) {
      const to = union.symbols[edge.to];
      if (to !== undefined && to.position.path !== fromPath) {
        reached.add(to.position.path);
      }
    }
  });
  return reached;
}

/**
 * The paths of the files an import reaches, a root names, or a declared edge names a
 * declaration in. A file holding a declaration the sweep judged live is kept whatever
 * held it live, and so is a file a program holds by inclusion, which acts on every
 * file of the program without an import naming it.
 */
function keptFiles({ swept, files, boundary }: EmitterInput): ReadonlySet<string> {
  const union = swept.matrix.union;
  const edgeNamed = new Set(boundary.edges.map((side) => side.symbol));
  const dead = new Set(swept.sweep.candidates.map((candidate) => candidate.id));
  const kept = new Set([...reachedFromOutside(union), ...files.heldByInclusion]);
  for (const root of union.rooted) {
    const named = union.symbols[root.at];
    if (named !== undefined) {
      kept.add(named.position.path);
    }
  }
  for (const symbol of union.symbols) {
    if ((symbol.kind !== FILE_SUBJECT && !dead.has(symbol.id)) || edgeNamed.has(symbol.ref)) {
      kept.add(symbol.position.path);
    }
  }
  return kept;
}

/** Every file of the run that no import reaches and no root or edge names. */
function fileNeverImported(input: EmitterInput): readonly Finding[] {
  const kept = keptFiles(input);
  return input.swept.matrix.union.symbols
    .filter((symbol) => symbol.kind === FILE_SUBJECT && !kept.has(symbol.position.path))
    .map((symbol) =>
      fileFinding(
        FILE_NEVER_IMPORTED,
        { path: symbol.position.path, ref: symbol.ref, endLine: symbol.endLine },
        "no import reaches this file and no root names it or a declaration in it",
      ),
    );
}

/** The findings of the non-code-artifacts family, `DS1500` to `DS1599`. */
export const nonCodeArtifacts: Emitter = (input) => [
  ...fileNeverBuilt(input),
  ...fileNeverImported(input),
];
