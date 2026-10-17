import type { SourceFile } from "@typescript/native/ast";
import {
  isNoSubstitutionTemplateLiteral,
  isStringLiteral,
  type Node,
} from "@typescript/native/ast";
import { packageOfSpecifier } from "../dependencies.ts";
import { MANIFEST } from "../fs/manifest.ts";
import { entriesOf } from "../fs/tree.ts";
import type { Host } from "../host.ts";
import { dirnamePath, isAbsolutePath, joinPath, relativePath, resolvePath } from "../paths.ts";
import { dependencySpecifiers, installedPackage, manifestsAbove } from "./module-lookup.ts";
import type { CompilerOptions } from "./plan.ts";

/** Where one project reads what its imports may name. */
export interface ModuleContext {
  readonly host: Host;
  /** The root of the module the project is the target's or a consumer's, absolute. */
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
  for (const { dir: at, manifest } of manifestsAbove(host, dir, targetRoot)) {
    if (dependencySpecifiers(manifest, name).length > 0) {
      return joinPath(at, MANIFEST);
    }
  }
  return undefined;
}

/**
 * Why one import that the compiler cannot resolve names a module the project expects,
 * with the fix, or undefined where the module is one the project does not expect.
 */
function expectedModule(
  context: ModuleContext,
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
  if (name !== undefined && installedPackage(host, dirnamePath(importer), name) !== undefined) {
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

/** The `paths` mapping of the configuration at `configFile` whose parse answered `options`. */
export function pathsOf(configFile: string, options: CompilerOptions): PathsMapping {
  // The parse answers `pathsBasePath`, the directory of the configuration that writes
  // `paths` (an extended one included), though the client's option type omits it:
  // https://github.com/microsoft/typescript-go/blob/89d5d5b2849a0db0957065889ca58536fa6d2e4a/internal/tsoptions/tsconfigparsing.go#L1120
  const declaredAt = (options as { readonly pathsBasePath?: unknown }).pathsBasePath;
  return {
    base: typeof declaredAt === "string" ? declaredAt : dirnamePath(configFile),
    entries: Object.entries(options.paths ?? {}).map(([key, targets]) => ({ key, targets })),
  };
}

/**
 * Why one import the compiler cannot resolve, at `offset` of `file`, names a module the project
 * expects and nothing provides, with the fix; undefined where the project does not expect it.
 */
export function missingModule(
  context: ModuleContext,
  file: SourceFile,
  offset: number,
): { readonly specifier: string; readonly reason: string } | undefined {
  const specifier = literalAt(file, offset);
  const reason =
    specifier === undefined ? undefined : expectedModule(context, file.fileName, specifier);
  return specifier === undefined || reason === undefined ? undefined : { specifier, reason };
}
