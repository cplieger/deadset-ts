/**
 * The globals a test runner injects into every file it runs, which no import names: a
 * Vitest configuration whose `test.globals` is `true` gives each test and each file it
 * loads `describe`, `it`, `expect` and `vi` (https://vitest.dev/config/globals). A program
 * analyzed without the runner's declarations of them reads every use as an error, so a
 * configuration under such a runner is read with them; and a file that calls one is
 * written for the runner, as one that imports it is.
 */

import {
  isAsExpression,
  isBinaryExpression,
  isCallExpression,
  isExportAssignment,
  isExpressionStatement,
  isIdentifier,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSatisfiesExpression,
  SyntaxKind,
  type Node,
  type SourceFile,
} from "@typescript/native/ast";
import type { ParseFile } from "../configuration-files.ts";
import type { Host } from "../host.ts";
import { isRecord } from "../json-document.ts";
import { ancestors, dirnamePath, joinPath } from "../paths.ts";
import { UNANSWERED } from "../query.ts";
import type { ProjectView } from "../session.ts";
import { filesIn } from "../fs/tree.ts";
import { holdsManifest, INSTALLED_PACKAGES } from "../fs/manifest.ts";
import { isTargetConfiguration } from "./discover.ts";
import type { ProgramPlan } from "./plan.ts";

/** The test runner whose configuration injects the globals, and the `types` entry declaring them. */
export const GLOBALS_RUNNER = "vitest";
const GLOBALS_TYPES = "vitest/globals";

/** The configuration files the runner reads its settings from, by name. */
const RUNNER_CONFIG = /^(?:vitest|vite)\.config\.(?:js|mjs|cjs|ts|mts|cts)$/u;

/** The globals `vitest/globals` declares that a test or a helper calls or reads a member of. */
const GLOBAL_NAMES: ReadonlySet<string> = new Set([
  "afterAll",
  "afterEach",
  "assert",
  "assertType",
  "beforeAll",
  "beforeEach",
  "bench",
  "describe",
  "expect",
  "expectTypeOf",
  "it",
  "onTestFailed",
  "onTestFinished",
  "suite",
  "test",
  "vi",
  "vitest",
]);

/** The expression one wrapper that changes no value holds, and a call's first argument. */
function configObject(node: Node): Node | undefined {
  let at: Node | undefined = node;
  while (at !== undefined) {
    if (isParenthesizedExpression(at) || isAsExpression(at) || isSatisfiesExpression(at)) {
      at = at.expression;
    } else if (isCallExpression(at)) {
      at = at.arguments[0];
    } else {
      return at;
    }
  }
  return undefined;
}

/** The value one object literal writes for one member as `name: value`. */
function member(object: Node | undefined, name: string): Node | undefined {
  if (object === undefined || !isObjectLiteralExpression(object)) {
    return undefined;
  }
  for (const property of object.properties) {
    if (
      isPropertyAssignment(property) &&
      isIdentifier(property.name) &&
      property.name.text === name
    ) {
      return configObject(property.initializer);
    }
  }
  return undefined;
}

/** Whether one runner configuration's default export sets `test.globals` to `true`. */
function setsGlobals(file: SourceFile): boolean {
  for (const statement of file.statements) {
    let exported: Node | undefined;
    if (isExportAssignment(statement)) {
      exported = statement.expression;
    } else if (isExpressionStatement(statement) && isBinaryExpression(statement.expression)) {
      const { left, operatorToken, right } = statement.expression;
      if (
        operatorToken.kind === SyntaxKind.EqualsToken &&
        isPropertyAccessExpression(left) &&
        isIdentifier(left.expression) &&
        left.expression.text === "module" &&
        isIdentifier(left.name) &&
        left.name.text === "exports"
      ) {
        exported = right;
      }
    }
    const object = exported === undefined ? undefined : configObject(exported);
    const globals = member(member(object, "test"), "globals");
    if (globals?.kind === SyntaxKind.TrueKeyword) {
      return true;
    }
  }
  return false;
}

/** Whether the runner's configuration in one manifest's directory injects the globals. */
function injectsGlobals(host: Host, parse: ParseFile, dir: string): boolean {
  return filesIn(host, dir, (name) => RUNNER_CONFIG.test(name)).some((name) => {
    const path = joinPath(dir, name);
    try {
      return setsGlobals(parse(path, host.readFile(path)));
    } catch {
      return false;
    }
  });
}

/** Whether a file declaring the globals is installed where the configuration resolves packages from. */
function globalsInstalled(host: Host, configFile: string): boolean {
  return ancestors(dirnamePath(configFile)).some(
    (dir) =>
      host.kindOf(joinPath(dir, INSTALLED_PACKAGES, GLOBALS_RUNNER, "globals.d.ts")) === "file",
  );
}

/** The directory of the manifest nearest one configuration file, at or above its own. */
function manifestDir(host: Host, configFile: string): string | undefined {
  return ancestors(dirnamePath(configFile)).find((dir) => holdsManifest(host, dir));
}

function typesOf(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((one) => typeof one === "string") ? value : undefined;
}

/**
 * The plans with the globals' declarations added to the `types` of each target configuration
 * whose nearest manifest's runner configuration injects them and that can resolve them.
 */
export function testGlobals(
  host: Host,
  parse: ParseFile,
  plans: readonly ProgramPlan[],
): readonly ProgramPlan[] {
  const injects = new Map<string, boolean>();
  return plans.map((plan): ProgramPlan => {
    const dir = manifestDir(host, plan.configFile);
    if (
      !isTargetConfiguration(plan) ||
      dir === undefined ||
      !globalsInstalled(host, plan.configFile)
    ) {
      return plan;
    }
    if (!injects.has(dir)) {
      injects.set(dir, injectsGlobals(host, parse, dir));
    }
    const base = typesOf(plan.options.types) ?? [];
    const { build } = plan;
    if (injects.get(dir) !== true) {
      return plan;
    }
    if (build.kind === "program") {
      const listed = typesOf(build.params.compilerOptions.types) ?? base;
      return listed.includes(GLOBALS_TYPES)
        ? plan
        : {
            ...plan,
            build: {
              kind: "program",
              params: {
                ...build.params,
                compilerOptions: {
                  ...build.params.compilerOptions,
                  types: [...listed, GLOBALS_TYPES],
                },
              },
            },
          };
    }
    const written = build.kind === "configuration" ? build.value : { extends: plan.configFile };
    const held = written["compilerOptions"];
    const options = isRecord(held) ? held : {};
    const listed = typesOf(options["types"]) ?? base;
    return listed.includes(GLOBALS_TYPES)
      ? plan
      : {
          ...plan,
          build: {
            kind: "configuration",
            value: {
              ...written,
              compilerOptions: { ...options, types: [...listed, GLOBALS_TYPES] },
            },
          },
        };
  });
}

/**
 * Whether one file names a global the runner injects, which is how a file written for the
 * runner's globals reads: a call of one of the names or a read of a member of it that
 * resolves to a declaration outside the project's own files, the runner's declaration
 * file. A name the file binds, imported, declared or a parameter, resolves to its own.
 */
export function namesTestGlobals<Brand>(project: ProjectView<Brand>, file: SourceFile): boolean {
  const named: Node[] = [];
  const visit = (node: Node): void => {
    const callee = isCallExpression(node)
      ? node.expression
      : isPropertyAccessExpression(node)
        ? node.expression
        : undefined;
    if (callee !== undefined && isIdentifier(callee) && GLOBAL_NAMES.has(callee.text)) {
      named.push(callee);
    }
    node.forEachChild(visit);
  };
  file.forEachChild(visit);
  if (named.length === 0) {
    return false;
  }
  const own = project.ownPaths();
  return project
    .symbolsAt(named.map((node) => project.handle(node)))
    .some(
      (symbol) =>
        symbol === UNANSWERED ||
        (symbol !== undefined &&
          symbol.declarations.length > 0 &&
          symbol.declarations.every((handle) => !own.has(handle.path))),
    );
}
