/**
 * What a type error in a project's own file does: the function, method or file-level statement
 * holding it is skipped, which only ever withholds a finding.
 */

import {
  isClassDeclaration,
  isFunctionLikeDeclaration,
  isPropertyAccessExpression,
  type Node,
  type PropertyAccessExpression,
  type SourceFile,
} from "@typescript/native/ast";
import type { Symbol as TSSymbol, Type } from "@typescript/native/sync";
import { nodeKey, type Inventory } from "./inventory.ts";
import { relativePath } from "./paths.ts";
import { isAnswered } from "./query.ts";
import type { TypeErrorSkip } from "./report.ts";
import type { ProjectView } from "./session.ts";

/** The lines of one file a skip withholds every finding on. */
export interface SkippedUnit {
  /** The file, below the target root. */
  readonly path: string;
  readonly fromLine: number;
  readonly toLine: number;
}

/** Whether a finding's position falls inside a skipped unit. */
export function insideSkipped(
  skipped: readonly SkippedUnit[],
  position: { readonly path: string; readonly line: number },
): boolean {
  return skipped.some(
    (unit) =>
      unit.path === position.path && unit.fromLine <= position.line && position.line <= unit.toLine,
  );
}

/** One type error of an own file, with the unit it skips. */
export interface Skip {
  readonly record: TypeErrorSkip;
  readonly file: SourceFile;
  readonly unit: Node;
}

/**
 * The unit a type error at one offset skips: the innermost function holding it, else the
 * class member holding it where a top-level class does, else the top-level statement.
 */
function unitAt(file: SourceFile, offset: number): Node | undefined {
  const statement = file.statements.find((one) => one.pos <= offset && offset < one.end);
  if (statement === undefined) {
    return undefined;
  }
  let innermost: Node | undefined;
  const visit = (node: Node): void => {
    if (offset < node.getStart() || offset >= node.end) {
      return;
    }
    if (isFunctionLikeDeclaration(node)) {
      innermost = node;
    }
    node.forEachChild(visit);
  };
  visit(statement);
  if (innermost !== undefined || !isClassDeclaration(statement)) {
    return innermost ?? statement;
  }
  return statement.members.find((one) => one.pos <= offset && offset < one.end) ?? statement;
}

/** The compiler's message on one line, the target root spelled relative to itself. */
function messageOf(text: string, targetRoot: string): string {
  const line = text.split(`${targetRoot}/`).join("").split(/\s+/u).join(" ").trim();
  return line === "" ? "a type error" : line;
}

/** The skip one type error at `offset` of an own file makes, the root spelled relative to itself. */
export function skipAt(
  file: SourceFile,
  offset: number,
  line: number,
  text: string,
  targetRoot: string,
): Skip | undefined {
  const unit = unitAt(file, offset);
  const path = relativePath(targetRoot, file.fileName) ?? file.fileName;
  return unit === undefined
    ? undefined
    : { record: { path, line, message: messageOf(text, targetRoot) }, file, unit };
}

/** The lines each skip withholds, below the target root. */
export function skippedUnits(skips: readonly Skip[], targetRoot: string): readonly SkippedUnit[] {
  return skips.map(({ file, unit }) => ({
    path: relativePath(targetRoot, file.fileName) ?? file.fileName,
    fromLine: file.getLineAndCharacterOfPosition(unit.getStart()).line + 1,
    toLine: file.getLineAndCharacterOfPosition(unit.end).line + 1,
  }));
}

/**
 * The declarations the skips keep live: every one a skipped unit declares, and every
 * member of the type of each operand on which the unit selects a member the checker
 * could not resolve, because the selection could have named any of them.
 */
export function skippedRoots<Brand>(
  project: ProjectView<Brand>,
  held: Inventory,
  skips: readonly Skip[],
): readonly string[] {
  const kept = new Set<string>();
  const selections: PropertyAccessExpression[] = [];
  for (const { file, unit } of skips) {
    const visit = (node: Node): void => {
      const id = held.declarations.get(nodeKey(file, node));
      if (id !== undefined) {
        kept.add(id);
      }
      if (isPropertyAccessExpression(node)) {
        selections.push(node);
      }
      node.forEachChild(visit);
    };
    visit(unit);
  }
  if (selections.length === 0) {
    return [...kept];
  }
  const names = project.symbolsAt(selections.map((node) => project.handle(node.name)));
  // A name the checker did not answer for may have named any member, as an unresolved one may.
  const operands = selections.flatMap((node, at) => {
    const name = names[at];
    return name === undefined || !isAnswered(name) ? [node.expression] : [];
  });
  const own = project.ownPaths();
  const keepMembers = (type: Type): void => {
    const parts = type.isUnionType() ? project.queries.constituents(type) : [type];
    for (const part of isAnswered(parts) ? parts : []) {
      const properties = project.queries.propertiesOf(part);
      for (const property of isAnswered(properties) ? properties : ([] as TSSymbol[])) {
        for (const handle of property.declarations) {
          const node = own.has(handle.path) ? project.declarationAt(handle)?.node : undefined;
          const id =
            node === undefined
              ? undefined
              : held.declarations.get(nodeKey(node.getSourceFile(), node));
          if (id !== undefined) {
            kept.add(id);
          }
        }
      }
    }
  };
  for (const type of project.queries.typesAt(operands)) {
    if (type !== undefined && isAnswered(type)) {
      keepMembers(type);
    }
  }
  return [...kept];
}
