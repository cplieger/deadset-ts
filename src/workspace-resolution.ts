/**
 * Which file an import of a workspace package's name is read from. The package is the
 * one `node_modules` links the importer to or, with no link, the one the importer's
 * manifest depends on. A source file the compiler reaches stands; any other file is read
 * back to the source it is compiled from or to a manifest target that is source, a file
 * the package's configurations neither compile nor write is read as installed, and an
 * import nothing answers for is unresolved.
 */

import { emittedFrom } from "./emit-map.ts";
import type { Host } from "./host.ts";
import { dirnamePath, isAbsolutePath, joinPath, relativePath, resolvePath } from "./paths.ts";
import { satisfies } from "./version-range.ts";
import type { Workspace, WorkspaceMember } from "./workspace.ts";

/** What the compiler's own resolution answered for one import. */
export interface DefaultResolution {
  readonly resolvedFileName: string;
  /** Whether the compiler reads the file as a library's rather than the program's own. */
  readonly isExternalLibraryImport?: boolean | undefined;
}

/** The answer for one import. */
export type MemberResolution =
  /** No member import, or one the compiler's resolution already reads as it should. */
  | { readonly kind: "default" }
  /** A member's source file, read as a file of the program. */
  | { readonly kind: "source"; readonly file: string; readonly member: string }
  /** A member import no source file answers for, with why. */
  | {
      readonly kind: "unresolved";
      readonly member: string;
      readonly subpath: string;
      readonly reason: string;
    };

/** The manifest members that name an entry point for the subpath `.` without `exports`. */
const LEGACY_MEMBERS = ["types", "typings", "module", "main"] as const;

/** The dependency members a manifest declares other packages under. */
const DEPENDENCY_MEMBERS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

const SOURCE = /(?<!\.d)\.(?:[mc]?ts|tsx)$/u;
const OUTPUT = /(?:\.d\.[mc]?ts|\.[mc]?js|\.jsx)$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The package name a bare specifier names, or `undefined` for any other specifier. */
export function packageNameOf(specifier: string): string | undefined {
  if (
    specifier === "" ||
    specifier.startsWith(".") ||
    specifier.startsWith("#") ||
    isAbsolutePath(specifier) ||
    specifier.includes(":")
  ) {
    return undefined;
  }
  const [first, second] = specifier.split("/");
  if (specifier.startsWith("@")) {
    return second === undefined || second === "" ? undefined : `${first ?? ""}/${second}`;
  }
  return first;
}

function inside(dir: string, path: string): boolean {
  return path === dir || relativePath(dir, path) !== undefined;
}

/** The `exports` entry one subpath selects, with what a pattern's `*` matched. */
function exportsEntry(
  exportsField: unknown,
  subpath: string,
): { readonly value: unknown; readonly match?: string } | undefined {
  const map =
    isRecord(exportsField) && Object.keys(exportsField).some((key) => key.startsWith("."))
      ? exportsField
      : { ".": exportsField };
  if (Object.hasOwn(map, subpath)) {
    return { value: map[subpath] };
  }
  let best: { readonly key: string; readonly prefix: number; readonly match: string } | undefined;
  for (const key of Object.keys(map)) {
    const star = key.indexOf("*");
    if (star < 0 || key.slice(star + 1).includes("*")) {
      continue;
    }
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (
      subpath.length >= key.length &&
      subpath.startsWith(prefix) &&
      subpath.endsWith(suffix) &&
      (best === undefined ||
        prefix.length > best.prefix ||
        (prefix.length === best.prefix && key.length > best.key.length))
    ) {
      best = {
        key,
        prefix: prefix.length,
        match: subpath.slice(prefix.length, subpath.length - suffix.length),
      };
    }
  }
  return best === undefined ? undefined : { value: map[best.key], match: best.match };
}

/** The leaf a condition set selects from one `exports` value, in the order Node reads it. */
function selected(value: unknown, conditions: ReadonlySet<string>): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    for (const alternative of value) {
      const found = selected(alternative, conditions);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  for (const [key, held] of Object.entries(value)) {
    if (conditions.has(key)) {
      return selected(held, conditions);
    }
  }
  return undefined;
}

/** Every leaf one `exports` value carries, in document order. */
function leaves(value: unknown): readonly string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(leaves);
  }
  return isRecord(value) ? Object.values(value).flatMap(leaves) : [];
}

/** Whether one dependency specifier names one member, written from one directory. */
function dependsOn(specifier: string, member: WorkspaceMember, fromDir: string): boolean {
  const atPath = (path: string): boolean => resolvePath(fromDir, path) === member.dir;
  const inRange = (range: string): boolean =>
    member.version !== undefined && satisfies(member.version, range);
  if (specifier.startsWith("workspace:")) {
    const rest = specifier.slice("workspace:".length);
    if (rest.startsWith(".") || rest.startsWith("/")) {
      return atPath(rest);
    }
    const alias = /^((?:@[^/@]+\/)?[^/@]+)@(.*)$/u.exec(rest);
    const range = alias === null ? rest : (alias[2] ?? "");
    if (alias !== null && alias[1] !== member.name) {
      return false;
    }
    return range === "*" || range === "^" || range === "~" || inRange(range);
  }
  for (const protocol of ["file:", "link:"]) {
    if (specifier.startsWith(protocol)) {
      return atPath(specifier.slice(protocol.length));
    }
  }
  return inRange(specifier);
}

/** The resolution of member imports over one workspace. */
export interface WorkspaceResolver {
  readonly workspace: Workspace;
  /** Whether one specifier names a member at all, which is all that is asked before the compiler is. */
  names(specifier: string): boolean;
  /**
   * The member's source file one of its paths is or is compiled from, or `undefined`
   * where none is: a path that is build output and has no source is not one.
   */
  sourceOf(member: WorkspaceMember, path: string): string | undefined;
  /**
   * The answer for one import from one directory, under the conditions its resolution
   * mode selects. `answered` is the compiler's own resolution of it.
   */
  resolve(
    specifier: string,
    fromDir: string,
    conditions: ReadonlySet<string>,
    answered: DefaultResolution | undefined,
  ): MemberResolution;
}

/** The member one import names, the ambiguity named, or none. */
type Linked =
  | { readonly kind: "member"; readonly member: WorkspaceMember }
  | { readonly kind: "none" }
  | { readonly kind: "ambiguous"; readonly dirs: readonly string[] };

/** The member imports of one workspace, read from the members' sources. */
export function workspaceResolver(host: Host, workspace: Workspace): WorkspaceResolver {
  const links = new Map<string, string | undefined>();
  /** The directory `node_modules/<name>` names from one directory, links followed. */
  const linkedFrom = (name: string, dir: string): string | undefined => {
    const key = `${name}\u0000${dir}`;
    if (links.has(key)) {
      return links.get(key);
    }
    const candidate = joinPath(dir, "node_modules", name);
    let found: string | undefined;
    if (host.kindOf(candidate) === "absent") {
      const up = dirnamePath(dir);
      found = up === dir ? undefined : linkedFrom(name, up);
    } else {
      try {
        found = host.realPath(candidate);
      } catch {
        found = undefined;
      }
    }
    links.set(key, found);
    return found;
  };

  const linkOf = (candidates: readonly WorkspaceMember[], fromDir: string): Linked => {
    const name = candidates[0]?.name ?? "";
    const linked = linkedFrom(name, fromDir);
    if (linked !== undefined) {
      const member = candidates.find((one) => one.dir === linked);
      return member === undefined ? { kind: "none" } : { kind: "member", member };
    }
    const scope = workspace.memberOf(joinPath(fromDir, "package.json"));
    if (scope?.name === name) {
      return { kind: "member", member: scope };
    }
    const manifest = scope?.manifest;
    const declared = DEPENDENCY_MEMBERS.flatMap((field) => {
      const held = manifest?.[field];
      const specifier = isRecord(held) ? held[name] : undefined;
      return typeof specifier === "string" ? [specifier] : [];
    });
    const matched = candidates.filter((member) =>
      declared.some((specifier) => dependsOn(specifier, member, scope?.dir ?? fromDir)),
    );
    const [one, two] = matched;
    if (one === undefined) {
      return { kind: "none" };
    }
    return two === undefined
      ? { kind: "member", member: one }
      : { kind: "ambiguous", dirs: matched.map((member) => member.dir) };
  };

  /** The files a member's configurations compile, which is what makes a file there source. */
  const compiled = (member: WorkspaceMember, path: string): boolean =>
    member.configurations.some((configuration) => configuration.fileNames.has(path));

  /**
   * The member's source one of its paths is, or is compiled from: a TypeScript source
   * file, the source an output path maps back to, or a file one of the member's
   * configurations compiles. `undefined` where none is.
   */
  const sourceOf = (member: WorkspaceMember, path: string): string | undefined => {
    if (SOURCE.test(path) && host.kindOf(path) === "file") {
      return path;
    }
    for (const { layout } of member.configurations) {
      const candidates = layout === undefined ? [] : emittedFrom(path, layout);
      const found = candidates.find((candidate) => host.kindOf(candidate) === "file");
      if (found !== undefined) {
        return found;
      }
    }
    if (OUTPUT.test(path)) {
      const beside = emittedFrom(path, { sourceDirs: [] });
      const found = beside.find((candidate) => host.kindOf(candidate) === "file");
      if (found !== undefined) {
        return found;
      }
    }
    return compiled(member, path) && host.kindOf(path) === "file" ? path : undefined;
  };

  /** The targets a member's manifest names for one subpath, the selected one first. */
  const targetsOf = (
    member: WorkspaceMember,
    subpath: string,
    conditions: ReadonlySet<string>,
  ): readonly string[] => {
    const exportsField = member.manifest["exports"];
    if (exportsField !== undefined) {
      const entry = exportsEntry(exportsField, subpath);
      if (entry === undefined) {
        return [];
      }
      const first = selected(entry.value, conditions);
      const written = [...(first === undefined ? [] : [first]), ...leaves(entry.value)];
      const found = written
        .filter((target) => target.startsWith("./"))
        .map((target) =>
          entry.match === undefined ? target : target.replaceAll("*", entry.match),
        );
      return [...new Set(found)];
    }
    if (subpath === ".") {
      return LEGACY_MEMBERS.flatMap((field) => {
        const value = member.manifest[field];
        return typeof value === "string" ? [value] : [];
      });
    }
    return [
      subpath,
      `${subpath}.d.ts`,
      `${subpath}.js`,
      `${subpath}/index.d.ts`,
      `${subpath}/index.js`,
    ];
  };

  return {
    workspace,
    sourceOf,
    names: (specifier) => {
      const name = packageNameOf(specifier);
      return name !== undefined && workspace.named.has(name);
    },
    resolve(specifier, fromDir, conditions, answered) {
      const name = packageNameOf(specifier);
      const candidates = name === undefined ? undefined : workspace.named.get(name);
      if (name === undefined || candidates === undefined) {
        return { kind: "default" };
      }
      const subpath = specifier === name ? "." : `.${specifier.slice(name.length)}`;
      const linked = linkOf(candidates, fromDir);
      if (linked.kind === "none") {
        return { kind: "default" };
      }
      if (linked.kind === "ambiguous") {
        return {
          kind: "unresolved",
          member: name,
          subpath,
          reason: `${String(linked.dirs.length)} workspace packages are named ${name} (${linked.dirs.join(", ")}) and nothing links the importer to one of them; install the workspace, or declare the dependency with a range only one of them satisfies`,
        };
      }
      const { member } = linked;
      // A member no compiler configuration builds is read as the package manager
      // installed it, wherever the compiler's resolution found it.
      if (
        answered !== undefined &&
        (member.configurations.length === 0 || !inside(member.dir, answered.resolvedFileName))
      ) {
        return { kind: "default" };
      }
      if (answered !== undefined) {
        const source = sourceOf(member, answered.resolvedFileName);
        if (source !== undefined) {
          return source === answered.resolvedFileName && answered.isExternalLibraryImport !== true
            ? { kind: "default" }
            : { kind: "source", file: source, member: member.name };
        }
      }
      const targets = targetsOf(member, subpath, conditions);
      for (const target of targets) {
        const source = sourceOf(member, joinPath(member.dir, target));
        if (source !== undefined) {
          return { kind: "source", file: source, member: member.name };
        }
      }
      // A file the member's configurations neither compile nor write, a hand-written
      // declaration file or a bundler's output, is read as the package manager installed it.
      if (answered !== undefined) {
        return { kind: "default" };
      }
      const named = targets.length === 0 ? "no target" : targets.join(", ");
      const built = targets.some((target) => host.kindOf(joinPath(member.dir, target)) === "file");
      return {
        kind: "unresolved",
        member: name,
        subpath,
        reason: built
          ? `its manifest names ${named}, output no tsconfig*.json of the package maps back to source, and nothing installed links the importer to it; install the workspace, or point an exports condition the importing configuration's customConditions lists at its source`
          : member.configurations.length === 0
            ? `the package has no tsconfig*.json and its manifest names ${named}, which does not exist; build the package`
            : `its manifest names ${named}, which does not exist and which no tsconfig*.json of the package compiles to; build the package, give the tsconfig.json that compiles it an outDir and rootDir that map those targets, or point an exports condition the importing configuration's customConditions lists at its source`,
      };
    },
  };
}
