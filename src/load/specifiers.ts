/**
 * The module specifiers of the JavaScript files a configuration does not check, read for what
 * the compiler leaves unresolved. Unchecked JavaScript reports no unfound module, and a
 * JavaScript file may name a file that is absent on purpose, so an unresolved one is no failure
 * of the program: a relative one is noted, and only a configuration whose imported dependencies
 * are none of them installed fails, because its program is not the one the project runs.
 */

import {
  isBinaryExpression,
  isCallExpression,
  isParenthesizedExpression,
  isStringLiteralLikeNode,
  isTryStatement,
  SyntaxKind,
  type Node,
  type SourceFile,
  type StringLiteralLikeNode,
} from "@typescript/native/ast";
import type { Program } from "@typescript/native/sync";
import { packageOfSpecifier } from "../dependencies.ts";
import type { Failure } from "../failure.ts";
import { readManifestAt } from "../fs/manifest.ts";
import type { Host } from "../host.ts";
import { JAVASCRIPT_FILE } from "../javascript-file.ts";
import { ancestors, dirnamePath, relativePath, resolvePath } from "../paths.ts";
import { renderPosition, type Position } from "../position.ts";
import { batched, type Engine, type ProjectView } from "../session.ts";
import { dependencySpecifiers } from "./module-lookup.ts";

/** A relative specifier: `.`, `..`, or one starting `./` or `../`. */
const RELATIVE = /^\.\.?(?:\/|$)/u;

/** One relative specifier of a JavaScript file that resolves to no file. */
export interface UnresolvedSpecifier {
  readonly specifier: string;
  readonly position: Position;
}

/** What the specifiers of one project's unchecked JavaScript files say. */
interface SpecifierReading {
  readonly unresolved: readonly UnresolvedSpecifier[];
  /** The failure of a project whose imported dependencies are none of them installed. */
  readonly uninstalled: Failure | undefined;
}

/**
 * Whether one specifier is loaded optionally: written inside a `try` block, or as a call whose
 * result an `||` or a `??` falls back from, so the program is written for its absence.
 */
function optional(node: StringLiteralLikeNode): boolean {
  const call = node.parent;
  let operand: Node = call;
  let parent = call.parent as Node | undefined;
  while (parent !== undefined && isParenthesizedExpression(parent)) {
    operand = parent;
    parent = parent.parent;
  }
  if (
    isCallExpression(call) &&
    parent !== undefined &&
    isBinaryExpression(parent) &&
    parent.left === operand &&
    (parent.operatorToken.kind === SyntaxKind.BarBarToken ||
      parent.operatorToken.kind === SyntaxKind.QuestionQuestionToken)
  ) {
    return true;
  }
  for (let at: Node | undefined = node; at !== undefined; at = at.parent as Node | undefined) {
    const above = at.parent as Node | undefined;
    if (above !== undefined && isTryStatement(above) && above.tryBlock === at) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a manifest at or above `dir`, no higher than `root`, declares the package `name`. A
 * manifest that does not parse or cannot be read ends the search, because what it declares is
 * unanswered and a manifest above it is another package's.
 */
function declared(host: Host, dir: string, root: string, name: string): boolean {
  for (const at of ancestors(dir, root)) {
    const read = readManifestAt(host, at);
    if (read.kind === "malformed" || read.kind === "unread") {
      return false;
    }
    if (read.kind === "read" && dependencySpecifiers(read.manifest, name).length > 0) {
      return true;
    }
  }
  return false;
}

/** What a project's specifiers are read against. */
interface SpecifierContext {
  /** Whether the project's options check its JavaScript files, which then report their own. */
  readonly checked: boolean;
  /** The target root, absolute. */
  readonly root: string;
  /** The directories a configuration of the run emits into, whose paths name build output. */
  readonly outputs: readonly string[];
}

/**
 * The specifiers of every JavaScript file of `project`, where its options do not check
 * JavaScript, each asked of the compiler in batched round trips. A relative one naming a path
 * below one of the run's output directories names build output, which a build writes later.
 */
export function readSpecifiers<Brand>(
  engine: Engine,
  host: Host,
  project: ProjectView<Brand>,
  { checked, root, outputs }: SpecifierContext,
): SpecifierReading {
  if (checked) {
    return { unresolved: [], uninstalled: undefined };
  }
  const usages: { readonly file: SourceFile; readonly node: StringLiteralLikeNode }[] = [];
  for (const file of project.ownSourceFiles()) {
    if (JAVASCRIPT_FILE.test(file.fileName)) {
      for (const node of file.imports) {
        if (isStringLiteralLikeNode(node) && !optional(node)) {
          usages.push({ file, node });
        }
      }
    }
  }
  const answers = batched<
    (typeof usages)[number],
    ReturnType<Program["getResolvedModuleFromModuleSpecifier"]>
  >(engine, usages, ({ file, node }) =>
    project.program.getResolvedModuleFromModuleSpecifier.gen(node, file.fileName),
  );

  const unresolved: UnresolvedSpecifier[] = [];
  let missing: { readonly file: SourceFile; readonly node: StringLiteralLikeNode } | undefined;
  let installed = false;
  for (const [at, usage] of usages.entries()) {
    const resolved = (answers[at]?.resolvedFileName ?? "") !== "";
    const specifier = usage.node.text;
    const name = packageOfSpecifier(specifier);
    if (RELATIVE.test(specifier)) {
      const named = resolvePath(dirnamePath(usage.file.fileName), specifier);
      if (!resolved && !outputs.some((dir) => relativePath(dir, named) !== undefined)) {
        unresolved.push({
          specifier,
          position: renderPosition(usage.file, root, usage.node.getStart()),
        });
      }
    } else if (name !== undefined && declared(host, dirnamePath(usage.file.fileName), root, name)) {
      installed ||= resolved;
      missing ??= resolved ? undefined : usage;
    }
  }
  if (installed || missing === undefined) {
    return { unresolved, uninstalled: undefined };
  }
  const { path, line } = renderPosition(missing.file, root, missing.node.getStart());
  return {
    unresolved,
    uninstalled: {
      failureClass: "missing-module",
      detail: `${path}:${String(line)}: ${path} imports ${JSON.stringify(missing.node.text)}, a declared dependency, and no dependency the configuration's JavaScript files import is installed: run the package manager's install`,
    },
  };
}
