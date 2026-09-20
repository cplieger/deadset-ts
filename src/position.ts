import type { SourceFile } from "@typescript/native/unstable/ast";
import { relativePath } from "./paths.ts";

/**
 * Where one declaration is written, as every report renders it.
 *
 * The column counts UTF-16 code units, which is the unit the SARIF specification
 * and the Language Server Protocol count in, and which is also the unit the
 * compiler's own positions are measured in, so no conversion stands between the
 * two.
 */
export interface Position {
  /** The declaring file's path below the target root, with the solidus as separator. */
  readonly path: string;
  /** The line the declaration starts on, counted from one. */
  readonly line: number;
  /** The column, counted from one in UTF-16 code units. */
  readonly column: number;
}

/**
 * A file the program holds whose path is not below the target root, which leaves
 * the analysis unable to name a declaration it found. It ends the run rather than
 * being passed over, so a position that does not render is never silently dropped.
 */
export class PositionError extends Error {
  /** The file as the program named it. */
  readonly file: string;

  constructor(file: string, root: string) {
    super(`${file} is not below ${root}`);
    this.name = "PositionError";
    this.file = file;
  }
}

/**
 * The position of one offset of one file, rendered against the target root.
 *
 * `offset` is a UTF-16 code unit offset into the file's text, which is what every
 * node of the tree carries.
 */
export function renderPosition(file: SourceFile, root: string, offset: number): Position {
  const path = relativePath(root, file.fileName);
  if (path === undefined) {
    throw new PositionError(file.fileName, root);
  }
  const { line, character } = file.getLineAndCharacterOfPosition(offset);
  return { path, line: line + 1, column: character + 1 };
}

/**
 * The identifier of the declaration written at one position: the path, the line and
 * the column joined by colons. It is what the graph keys on inside one run, and
 * what the configuration intersection compares across projects, because a handle is
 * meaningful only inside the program that produced it while a rendered position is
 * meaningful anywhere.
 */
export function positionKey(position: Position): string {
  return `${position.path}:${String(position.line)}:${String(position.column)}`;
}

/**
 * Two positions ordered by file, line and column, which is the order the inventory
 * reads in and the order every set of a run is reported in.
 */
export function byPosition(a: Position, b: Position): number {
  if (a.path !== b.path) {
    return a.path < b.path ? -1 : 1;
  }
  if (a.line !== b.line) {
    return a.line - b.line;
  }
  return a.column - b.column;
}
