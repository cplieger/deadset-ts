/**
 * Where the compiler writes what it compiles: the output extension each source
 * extension becomes, and the output path one source path is written to. A path a
 * manifest or a document names is read back to its source through this one rule,
 * whether the path is the target's own or a workspace package's.
 */

import { dirnamePath, joinPath, relativePath } from "./paths.ts";

/** The source extensions the compiler emits each output extension from. */
const EMITTED: readonly { readonly emitted: string; readonly sources: readonly string[] }[] = [
  { emitted: ".d.ts", sources: [".ts", ".tsx"] },
  { emitted: ".d.mts", sources: [".mts"] },
  { emitted: ".d.cts", sources: [".cts"] },
  { emitted: ".js", sources: [".ts", ".tsx"] },
  { emitted: ".jsx", sources: [".tsx"] },
  { emitted: ".mjs", sources: [".mts"] },
  { emitted: ".cjs", sources: [".cts"] },
];

/** Where one compiler configuration writes its output, and the directories it writes it from. */
export interface EmitLayout {
  /** The directory every output is written below, absolute. */
  readonly outDir?: string | undefined;
  /** The directory declaration outputs are written below where it differs, absolute. */
  readonly declarationDir?: string | undefined;
  /**
   * The directories an output path below the output directory is read below, in the
   * order they are tried: the one the configuration declares, or the ones the
   * compiler's default may be.
   */
  readonly sourceDirs: readonly string[];
}

/** One path with its extension replaced, where it carries the one named. */
function reExtended(path: string, emitted: string, source: string): string | undefined {
  return path.endsWith(emitted) ? path.slice(0, path.length - emitted.length) + source : undefined;
}

/**
 * The longest directory every path shares, which is where the compiler roots its
 * output when the configuration declares no root directory and its directory is not
 * the root.
 */
export function commonDirectory(paths: readonly string[]): string {
  const first = paths[0];
  if (first === undefined) {
    return "";
  }
  let common = dirnamePath(first).split("/");
  for (const path of paths.slice(1)) {
    const segments = dirnamePath(path).split("/");
    let shared = 0;
    while (
      shared < common.length &&
      shared < segments.length &&
      common[shared] === segments[shared]
    ) {
      shared += 1;
    }
    common = common.slice(0, shared);
  }
  return common.join("/");
}

/**
 * The source paths one written path may be compiled from, in the order they are
 * tried: for each output extension the path carries, the path re-extended where it
 * stands, then read below each source directory where it is below the directory that
 * output is written to.
 */
export function emittedFrom(path: string, layout: EmitLayout): readonly string[] {
  const found: string[] = [];
  for (const { emitted, sources } of EMITTED) {
    if (!path.endsWith(emitted)) {
      continue;
    }
    const emitDir = emitted.startsWith(".d.")
      ? (layout.declarationDir ?? layout.outDir)
      : layout.outDir;
    const below = emitDir === undefined ? undefined : relativePath(emitDir, path);
    const mapped = below === undefined ? [] : layout.sourceDirs.map((dir) => joinPath(dir, below));
    for (const source of sources) {
      for (const from of [path, ...mapped]) {
        const candidate = reExtended(from, emitted, source);
        if (candidate !== undefined) {
          found.push(candidate);
        }
      }
    }
  }
  return found;
}
