import { CODE } from "../contract/contract.generated.ts";
import type { ResolvedConfig } from "../config.ts";
import type { Finding } from "../finding.ts";
import type { Emitter, EmitterInput } from "./emitter.ts";

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
    .map((file) => fileFinding(CODE.fileNeverBuilt, file, message));
}

/** The files of the run, each with whether a reference written in another file reaches it. */
interface KeptFiles {
  /** The files kept: reached from a live file, or named by a root, an edge or a program. */
  readonly kept: ReadonlySet<string>;
  /** The files a reference written in another file reaches, whatever holds that file. */
  readonly referenced: ReadonlySet<string>;
}

/**
 * The paths of the files a reference from a live declaration of another file reaches, a
 * loaded consumer's file included, a root names, or a declared edge names a declaration in,
 * and of every file a reference written anywhere reaches. A file holding a declaration the
 * sweep judged live is kept whatever held it live, and so is a file a program holds by
 * inclusion, which acts on every file of the program without an import naming it. A
 * reference from a file's top level counts once the file is kept.
 */
function keptFiles({ swept, files, boundary }: EmitterInput): KeptFiles {
  const union = swept.matrix.union;
  const edgeNamed = new Set(boundary.edges.map((side) => side.symbol));
  const dead = new Set(swept.sweep.candidates.map((candidate) => candidate.id));
  const kept = new Set(files.heldByInclusion);
  const referenced = new Set<string>();
  for (const edge of union.consumed) {
    const to = union.symbols[edge.to];
    if (to !== undefined) {
      kept.add(to.position.path);
    }
  }
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
  const fromTopLevel = new Map<string, string[]>();
  const pending: string[] = [];
  const keep = (path: string): void => {
    if (!kept.has(path)) {
      kept.add(path);
      pending.push(path);
    }
  };
  union.out.forEach((edges, from) => {
    const source = union.symbols[from];
    if (source === undefined) {
      return;
    }
    for (const edge of edges) {
      const to = union.symbols[edge.to]?.position.path;
      if (to === undefined || to === source.position.path) {
        continue;
      }
      referenced.add(to);
      if (source.kind === FILE_SUBJECT) {
        fromTopLevel.set(source.position.path, [
          ...(fromTopLevel.get(source.position.path) ?? []),
          to,
        ]);
      } else if (!dead.has(source.id)) {
        pending.push(to);
      }
    }
  });
  pending.push(...kept);
  for (let path = pending.pop(); path !== undefined; path = pending.pop()) {
    kept.add(path);
    for (const to of fromTopLevel.get(path) ?? []) {
      keep(to);
    }
    fromTopLevel.delete(path);
  }
  return { kept, referenced };
}

/**
 * Every file of the run that no reference from live code reaches and no root or edge
 * names. A file only dead code imports is found dead under reachability alone.
 */
function fileNeverImported(input: EmitterInput): readonly Finding[] {
  const { kept, referenced } = keptFiles(input);
  return input.swept.matrix.union.symbols
    .filter((symbol) => symbol.kind === FILE_SUBJECT && !kept.has(symbol.position.path))
    .map((symbol) => {
      const file = { path: symbol.position.path, ref: symbol.ref, endLine: symbol.endLine };
      return referenced.has(symbol.position.path)
        ? {
            ...fileFinding(
              CODE.fileNeverImported,
              file,
              "only code that is itself dead imports this file, and no root names it or a declaration in it",
            ),
            unreachableOnly: true as const,
          }
        : fileFinding(
            CODE.fileNeverImported,
            file,
            "no import reaches this file and no root names it or a declaration in it",
          );
    });
}

/** The findings of the files family, `DS1600` to `DS1699`. */
export const nonCodeArtifacts: Emitter = (input) => [
  ...fileNeverBuilt(input),
  ...fileNeverImported(input),
];
