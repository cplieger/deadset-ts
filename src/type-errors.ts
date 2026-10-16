/**
 * What the errors a project's own files carry do to the run. An import of a module the
 * project expects and nothing provides is a setup failure. Any other error in an own file
 * is a type error: the function, method or file-level statement holding it is skipped,
 * which only ever withholds a finding. `projectErrors` decides, before any of these, which
 * errors the compiler places in no file leave the project unloaded.
 */

import {
  isClassDeclaration,
  isFunctionLikeDeclaration,
  isNoSubstitutionTemplateLiteral,
  isPropertyAccessExpression,
  isStringLiteral,
  type Node,
  type PropertyAccessExpression,
  type SourceFile,
} from "@typescript/native/ast";
import type { Symbol as TSSymbol, Type } from "@typescript/native/sync";
import { packageOfSpecifier } from "./dependencies.ts";
import type { LocatedDiagnostic } from "./discover.ts";
import type { Host } from "./host.ts";
import { nodeKey, type Inventory } from "./inventory.ts";
import {
  ancestors,
  dirnamePath,
  isAbsolutePath,
  joinPath,
  relativePath,
  resolvePath,
} from "./paths.ts";
import { isAnswered } from "./query.ts";
import type { TypeErrorSkip } from "./report.ts";
import type { Engine, ProjectView } from "./session.ts";
import type { SetupFailure } from "./setup-failure.ts";
import { findWorkspace, type Workspace } from "./workspace.ts";
import { entriesOf } from "./fs/tree.ts";
import { INSTALLED_PACKAGES, MANIFEST, manifestAt } from "./fs/manifest.ts";

/** The compiler's codes for an import whose module it cannot find. */
const MODULE_NOT_FOUND: ReadonlySet<number> = new Set([2307, 2792]);

/**
 * The compiler's codes for where the configuration places a file, which leave every type
 * the file's statements carry as it is: an output that would overwrite an input (5055,
 * 5056), a file outside `rootDir` (6059), one a composite project does not list (6307).
 */
const CONFIGURATION_LEVEL: ReadonlySet<number> = new Set([5055, 5056, 6059, 6307]);

const MANIFEST_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

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
interface Skip {
  readonly record: TypeErrorSkip;
  readonly file: SourceFile;
  readonly unit: Node;
}

/** What the errors of one project's own files are. */
interface ProjectErrorReading {
  /** The imports of a module the project expects that nothing provides, one failure each. */
  readonly missing: readonly SetupFailure[];
  /** The type errors, each with the unit it skips. */
  readonly skips: readonly Skip[];
}

/** Where one project reads what its imports may name. */
interface ErrorContext {
  readonly host: Host;
  /** The target root, absolute. */
  readonly targetRoot: string;
  /** The project configuration's `paths` mapping. */
  readonly paths: PathsMapping;
  /** Whether one manifest is a workspace member's, whose dependencies the workspace installs. */
  readonly member: (manifest: string) => boolean;
}

/** One configuration's `paths` mapping, its targets read against `base`. */
interface PathsMapping {
  readonly base: string;
  readonly entries: readonly { readonly key: string; readonly targets: readonly string[] }[];
}

/** The string literal holding one offset, innermost first, a doc comment's included. */
function literalAt(file: SourceFile, offset: number): string | undefined {
  let found: string | undefined;
  const visit = (node: Node): void => {
    if (offset < node.pos || offset >= node.end) {
      return;
    }
    if (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) {
      found = node.text;
    }
    // `forEachChild` does not enter a doc comment, where a JavaScript file imports types.
    for (const doc of (node as { readonly jsDoc?: readonly Node[] }).jsDoc ?? []) {
      visit(doc);
    }
    node.forEachChild(visit);
  };
  file.forEachChild(visit);
  return found;
}

/**
 * What one `paths` key's `*` matches in one specifier, `""` for a key with no `*` that
 * is the specifier, or `undefined` where the key does not match it.
 */
function mappedBy(key: string, specifier: string): string | undefined {
  const star = key.indexOf("*");
  if (star < 0) {
    return key === specifier ? "" : undefined;
  }
  const prefix = key.slice(0, star);
  const suffix = key.slice(star + 1);
  return specifier.length >= prefix.length + suffix.length &&
    specifier.startsWith(prefix) &&
    specifier.endsWith(suffix)
    ? specifier.slice(prefix.length, specifier.length - suffix.length)
    : undefined;
}

/**
 * One `paths` target, its first `*` replaced by `star` taken literally, as the compiler does:
 * https://github.com/microsoft/typescript-go/blob/89d5d5b2849a0db0957065889ca58536fa6d2e4a/internal/module/resolver.go#L1282
 */
function substituted(target: string, star: string): string {
  const at = target.indexOf("*");
  return at < 0 ? target : target.slice(0, at) + star + target.slice(at + 1);
}

/**
 * Whether a path names something on disk, as written or with any extension; under
 * `fileOnly`, only a file counts.
 */
function provided(host: Host, path: string, fileOnly: boolean): boolean {
  const counts = (at: string): boolean =>
    fileOnly ? host.kindOf(at) === "file" : host.kindOf(at) !== "absent";
  if (counts(path)) {
    return true;
  }
  const dir = dirnamePath(path);
  const stem = `${path.slice(dir.length + 1)}.`;
  return entriesOf(host, dir).some(
    (entry) => entry.name.startsWith(stem) && counts(joinPath(dir, entry.name)),
  );
}

/** The manifest at or above `dir`, no higher than the target root, that declares `name`. */
function declaringManifest(
  host: Host,
  dir: string,
  targetRoot: string,
  name: string,
): string | undefined {
  const chain = ancestors(dir, targetRoot);
  // A directory outside the target root reads its own manifest alone.
  for (const at of chain.length > 0 ? chain : [dir]) {
    const manifest = manifestAt(host, at);
    for (const section of MANIFEST_SECTIONS) {
      const declared = manifest?.[section];
      if (typeof declared === "object" && declared !== null && Object.hasOwn(declared, name)) {
        return joinPath(at, MANIFEST);
      }
    }
  }
  return undefined;
}

/**
 * Whether a package is installed for an importer in `dir`: in the `node_modules` of
 * `dir` or of any ancestor, above the target root too, as Node and the compiler look.
 */
function installed(host: Host, dir: string, name: string): boolean {
  return ancestors(dir).some(
    (at) => host.kindOf(joinPath(at, INSTALLED_PACKAGES, name)) === "directory",
  );
}

/**
 * Why one import that the compiler cannot resolve names a module the project expects,
 * with the fix, or undefined where the module is one the project does not expect.
 */
function expectedModule(
  context: ErrorContext,
  importer: string,
  specifier: string,
): string | undefined {
  const { host, targetRoot } = context;
  const fix = "run the generator or the build that writes it";
  if (specifier.startsWith(".") || isAbsolutePath(specifier)) {
    return provided(host, resolvePath(dirnamePath(importer), specifier), false)
      ? undefined
      : `which names no file of the target: ${fix}`;
  }
  if (specifier.startsWith("#")) {
    return `which the manifest's imports map to no file: ${fix}`;
  }
  const mapped = context.paths.entries.flatMap(({ key, targets }) => {
    const star = mappedBy(key, specifier);
    return star === undefined
      ? []
      : targets.map((target) => resolvePath(context.paths.base, substituted(target, star)));
  });
  const name = packageOfSpecifier(specifier);
  // The compiler looks up in `node_modules` what `paths` does not resolve, so the error
  // of an installed package's import is the import's own, a subpath its exports omit:
  // https://github.com/microsoft/typescript-go/blob/89d5d5b2849a0db0957065889ca58536fa6d2e4a/internal/module/resolver.go#L548-L575
  if (name !== undefined && installed(host, dirnamePath(importer), name)) {
    return undefined;
  }
  if (mapped.length > 0) {
    return mapped.some((path) => provided(host, path, true))
      ? undefined
      : `which the compiler configuration's paths map to no file: ${fix}`;
  }
  const manifest =
    name === undefined
      ? undefined
      : declaringManifest(host, dirnamePath(importer), targetRoot, name);
  // No run requires a nested package that is no workspace member to be installed.
  if (
    manifest === undefined ||
    (dirnamePath(manifest) !== targetRoot && !context.member(manifest))
  ) {
    return undefined;
  }
  const where = relativePath(targetRoot, manifest) ?? manifest;
  return `a dependency ${where} declares that is not installed: run the package manager's install`;
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

/**
 * Reads the errors one project's own files carry. A diagnostic marking unnecessary code
 * or about where the configuration places a file is no error here, and one in a file that
 * is not the project's own is that file's package's to answer for.
 */
export function readErrors<Brand>(
  project: ProjectView<Brand>,
  errors: readonly LocatedDiagnostic[],
  where: Omit<ErrorContext, "member">,
): ProjectErrorReading {
  let workspace: Workspace | undefined | null = null;
  const context: ErrorContext = {
    ...where,
    member: (manifest) => {
      if (workspace === null) {
        workspace = findWorkspace(where.host, where.targetRoot, () => undefined);
      }
      return workspace?.memberOf(manifest) !== undefined;
    },
  };
  const files = new Map(project.ownSourceFiles().map((file) => [file.fileName, file]));
  const missing: SetupFailure[] = [];
  const skips: Skip[] = [];
  for (const { diagnostic, at } of errors) {
    const file = diagnostic.fileName === undefined ? undefined : files.get(diagnostic.fileName);
    if (
      file === undefined ||
      diagnostic.reportsUnnecessary === true ||
      CONFIGURATION_LEVEL.has(diagnostic.code)
    ) {
      continue;
    }
    const path = relativePath(context.targetRoot, file.fileName) ?? file.fileName;
    const line = at?.line ?? 1;
    const specifier = MODULE_NOT_FOUND.has(diagnostic.code)
      ? literalAt(file, diagnostic.pos)
      : undefined;
    const expected =
      specifier === undefined ? undefined : expectedModule(context, file.fileName, specifier);
    if (specifier !== undefined && expected !== undefined) {
      missing.push({
        setupClass: "missing-module",
        detail: `${path}:${String(line)}: ${path} imports ${JSON.stringify(specifier)}, ${expected}`,
      });
      continue;
    }
    const unit = unitAt(file, diagnostic.pos);
    if (unit !== undefined) {
      skips.push({
        record: { path, line, message: messageOf(diagnostic.text, context.targetRoot) },
        file,
        unit,
      });
    }
  }
  return { missing, skips };
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

/** One compiler configuration's `paths` mapping, empty where it cannot be read. */
export function pathsOf(engine: Engine, configFile: string): PathsMapping {
  const base = dirnamePath(configFile);
  try {
    const { options } = engine.parseConfigFile(configFile);
    const { paths } = options;
    // The parse answers `pathsBasePath`, the directory of the configuration that writes
    // `paths` (an extended one included), though the client's option type omits it:
    // https://github.com/microsoft/typescript-go/blob/89d5d5b2849a0db0957065889ca58536fa6d2e4a/internal/tsoptions/tsconfigparsing.go#L1120
    const declaredAt = (options as { readonly pathsBasePath?: unknown }).pathsBasePath;
    return {
      base: typeof declaredAt === "string" ? declaredAt : base,
      entries: Object.entries(paths ?? {}).map(([key, targets]) => ({ key, targets })),
    };
  } catch {
    return { base, entries: [] };
  }
}
