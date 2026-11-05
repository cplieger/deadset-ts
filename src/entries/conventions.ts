/**
 * The convention rows a run applies, and the files they root. A row applies to a
 * manifest that declares its enabling package when the installed package's version is
 * in the row's range; its globs are read against that manifest's directory, with every
 * directory a configuration property moves read from the property's literal value.
 * No configuration file is run.
 */

import type { SourceFile } from "@typescript/native/ast";
import { lineOf } from "../component-files.ts";
import {
  CONVENTION_ROWS,
  type ConventionRow,
  type DirectoryMove,
  type HelperReading,
  type ManifestEntryKey,
  type MoveReading,
  type OptionsCall,
  type PackageKey,
  type PrefixedNameReading,
  type ShortNameReading,
  type TestDirectoryReading,
  type TestFileReading,
} from "./convention-rows.ts";
import { documentStrings } from "./configuration-files.ts";
import { readCommands } from "../commands/read.ts";
import {
  nodeTestGlobs,
  type RunnerInput,
  type ScriptCommand,
  type TestGlob,
} from "./test-runners.ts";
import {
  documentModule,
  membersNamed,
  staticModule,
  textsOf,
  valuesAt,
  type StaticModule,
  type Value,
} from "./static-module.ts";
import type { Host } from "../host.ts";
import {
  ancestors,
  dirnamePath,
  joinPath,
  normalizePath,
  relativePath,
  resolvePath,
} from "../paths.ts";
import type { Failure } from "../failure.ts";
import type { SourceFiles } from "../source-files.ts";
import { satisfies } from "../version-range.ts";
import { bytewise } from "../text/compare.ts";
import { isRecord } from "../json-document.ts";
import { filesIn } from "../fs/tree.ts";
import { DEPENDENCY_SECTIONS, INSTALLED_PACKAGES, MANIFEST, readJSON } from "../fs/manifest.ts";
import { globExpression } from "../text/glob.ts";
import { yamlDocument } from "../text/yaml.ts";
import { APPENDED_EXTENSIONS, braced } from "../extensions.ts";

/** One manifest the analysis reads. */
export interface ConventionManifest {
  /** The manifest's directory, absolute. */
  readonly dir: string;
  /** The manifest's path below the target root, `/`-separated. */
  readonly path: string;
  /**
   * Whether the manifest is a nested package's, whose install no run requires: an
   * enabling package it declares and nothing installs applies no row and fails nothing.
   */
  readonly nested?: boolean;
}

/** One row a run applied, as the report lists it. */
export interface AppliedConvention {
  readonly name: string;
  readonly package: string;
  /** The version the installed package's own manifest names. */
  readonly version: string;
  /** The declaring manifest's path below the target root. */
  readonly manifest: string;
}

/** One glob of an applied row, read against its manifest's directory. */
interface ConventionGlob {
  readonly dir: string;
  readonly row: string;
  readonly expression: RegExp;
  /** The expressions of the row's excludes, read against the same directory. */
  readonly excludes: readonly RegExp[];
}

/** One directory an applied row names as generated, read against its manifest's directory. */
interface GeneratedDirectory {
  readonly dir: string;
  readonly row: string;
  /** The directory below the manifest's directory, `/`-separated. */
  readonly below: string;
}

/** A setup failure a row met, at the directory of the manifest that declared it. */
interface ConventionFailure {
  readonly dir: string;
  readonly failure: Failure;
}

/** What the rows decided for one run. */
export interface Conventions {
  /** The rows applied, ordered by name, then manifest, then their compact encoding. */
  readonly applied: readonly AppliedConvention[];
  readonly globs: readonly ConventionGlob[];
  readonly generated: readonly GeneratedDirectory[];
  readonly failures: readonly ConventionFailure[];
  /**
   * The dependencies the applied rows' short names, manifest keys and helper settings use,
   * by name, each once.
   */
  readonly uses: readonly string[];
  /** Per configuration file, absolute, the strings its applied rows' selection keys hold. */
  readonly selected: ReadonlyMap<string, Selected>;
  /** The files, absolute, an applied row's test-file properties name, each with the string naming it. */
  readonly testFiles: ReadonlyMap<string, string>;
  /** The test-file patterns of the applied rows' test directory readings. */
  readonly testGlobs: readonly TestGlob[];
}

/** The strings one configuration file holds at selection keys, which root no file. */
export interface Selected {
  /** Where each string starts in the file's text. */
  readonly starts: ReadonlySet<number>;
  /** Each string's text, once per occurrence. */
  readonly texts: readonly string[];
}

/** One file a row roots. */
interface ConventionEntry {
  readonly file: SourceFile;
  /** The row's name. */
  readonly row: string;
}

/** Parses one file's text with no program. */
type ParseSource = (fileName: string, text: string) => SourceFile;

/** A configuration file its tool reads as a YAML document. */
const YAML_NAME = /\.ya?ml$/u;

/** A configuration file its tool reads as a JSON document whose name does not end with `.json`. */
const JSON_NAME = /^\.[\w-]+rc$|\.jsonc$/u;

/** The sections an installed package is required by, so its absence fails the run. */
const REQUIRED_SECTIONS = ["dependencies", "devDependencies"] as const;

function declares(
  manifest: unknown,
  name: string,
  sections: readonly string[] = DEPENDENCY_SECTIONS,
): boolean {
  if (!isRecord(manifest)) {
    return false;
  }
  return sections.some((section) => {
    const held = manifest[section];
    return isRecord(held) && Object.hasOwn(held, name);
  });
}

/**
 * The version the installed package's manifest names, read from the nearest
 * `node_modules` at or above `dir` that holds it, `""` where that manifest names
 * none, or `undefined` where no `node_modules` holds it.
 */
function installedVersion(host: Host, dir: string, name: string): string | undefined {
  for (const at of ancestors(dir)) {
    const path = joinPath(at, INSTALLED_PACKAGES, name, MANIFEST);
    if (host.kindOf(path) === "file") {
      const manifest = readJSON(host, path);
      const version = isRecord(manifest) ? manifest["version"] : undefined;
      return typeof version === "string" ? version : "";
    }
  }
  return undefined;
}

/** The objects a reading reads in one configuration file: each named call's options, or the default export. */
function readObjects(module: StaticModule, call: OptionsCall | undefined): readonly Value[] {
  return call === undefined ? module.defaultExport : module.options(call.module, call.export);
}

/** Where a value that a reading cannot take as a literal is written, undefined in a document with no positions. */
interface NotLiteral {
  readonly at: number | undefined;
}

/**
 * Reads the values at one path of keys below one object into `values`, and answers the
 * first place that does not write its value out: an object that is no object literal, a
 * spread or a computed key, a value at the path's end that is no literal, or one before
 * it that is no object literal.
 */
function readPath(
  object: Value,
  keys: readonly string[],
  values: string[],
  elements: boolean,
): NotLiteral | undefined {
  if (object.kind !== "object") {
    return object;
  }
  const [key, ...rest] = keys;
  for (const member of object.members) {
    if (member.key === undefined) {
      return member;
    }
    if (member.key !== key) {
      continue;
    }
    if (rest.length === 0) {
      const texts = textsOf(member.value, elements);
      if (texts === undefined) {
        return member;
      }
      values.push(...texts);
    } else {
      const failed =
        member.value.kind === "object" ? readPath(member.value, rest, values, elements) : member;
      if (failed !== undefined) {
        return failed;
      }
    }
  }
  return undefined;
}

/** The text values among the values at one path: each value itself, or each element of an array value. */
function stringsAt(
  objects: readonly Value[],
  property: string,
): readonly { readonly text: string; readonly at: number | undefined }[] {
  return valuesAt(objects, property.split(".")).flatMap((value) =>
    (value.kind === "array" ? value.elements : [value]).flatMap((one) =>
      one.kind === "text" ? [one] : [],
    ),
  );
}

/** Whether one value holds a helper setting's value, as {@link HelperReading} states it. */
function holdsValue(held: Value, value: true | string): boolean {
  if (value === true) {
    return held.kind === "boolean" && held.value;
  }
  if (held.kind === "text") {
    return held.text === value;
  }
  return (
    held.kind === "array" &&
    held.elements.some((element) => {
      const first = element.kind === "array" ? element.elements[0] : element;
      return first?.kind === "text" && first.text === value;
    })
  );
}

/** The directory one group of objects' test-file strings are read against, as {@link TestFileReading} states it. */
function testFileRoot(
  objects: readonly Value[],
  dir: string,
  roots: readonly string[],
): string | undefined {
  for (const property of roots) {
    const values = valuesAt(objects, property.split("."));
    if (values.length > 0) {
      const texts = new Set(values.map((one) => (one.kind === "text" ? one.text : undefined)));
      const [text] = texts;
      return texts.size === 1 && text !== undefined ? resolvePath(dir, text) : undefined;
    }
  }
  return dir;
}

/**
 * The files an applied row's test-file properties name, each string also added to
 * `selected`, since a test file is rooted by no configuration string (conventions.11). A
 * property's path up to its last `*` selects objects that each resolve their strings
 * against their own roots.
 */
function testFilesNamed(
  read: ReadFiles,
  dir: string,
  readings: readonly TestFileReading[],
  into: Map<string, string>,
  selected: Map<string, { starts: Set<number>; texts: string[] }>,
): void {
  for (const reading of readings) {
    const star = reading.property.lastIndexOf("*.");
    const each = star < 0 ? undefined : reading.property.slice(0, star + 1).split(".");
    const property = star < 0 ? reading.property : reading.property.slice(star + 2);
    for (const { name, module } of read(dir, reading.files)) {
      const path = joinPath(dir, name);
      const held = selected.get(path) ?? { starts: new Set<number>(), texts: [] };
      selected.set(path, held);
      const objects = readObjects(module, reading.call);
      const groups = each === undefined ? [objects] : valuesAt(objects, each).map((one) => [one]);
      for (const group of groups) {
        const at = testFileRoot(group, dir, reading.roots);
        if (at === undefined) {
          continue;
        }
        for (const { text, at: start } of stringsAt(group, property)) {
          if (start !== undefined) {
            held.starts.add(start);
          }
          held.texts.push(text);
          if (text !== "") {
            into.set(resolvePath(at, text), text);
          }
        }
      }
    }
  }
}

/** The directory and patterns one configuration object's tests are read from, undefined where its text does not state them. */
interface TestDirectory {
  readonly directory: string;
  readonly patterns: readonly string[];
}

/** The one value an object's last write of a key gives, `null` where it writes none, undefined where it may hide one. */
function lastMember(object: Value, key: string): Value | null | undefined {
  const values = membersNamed(object, key);
  return values === undefined ? undefined : (values.at(-1) ?? null);
}

/** The test directory one object states, each member it does not write taken from `inherited`. */
function testDirectoryOf(
  object: Value,
  reading: TestDirectoryReading,
  inherited: TestDirectory,
): TestDirectory | undefined {
  if (object.kind !== "object") {
    return undefined;
  }
  const directory = lastMember(object, reading.directory);
  const match = lastMember(object, reading.match);
  if (directory === undefined || match === undefined) {
    return undefined;
  }
  const dirs = directory === null ? [inherited.directory] : textsOf(directory, false);
  const patterns = match === null ? inherited.patterns : textsOf(match, true);
  const [one] = dirs ?? [];
  return one === undefined || patterns === undefined ? undefined : { directory: one, patterns };
}

/**
 * The test-file patterns an applied row's test directory readings give: each configuration
 * object's own, or, where it lists projects, each project's, a member a project does not
 * write taken from the configuration. An object whose text does not state them gives none.
 */
function testDirectoryGlobs(
  read: ReadFiles,
  dir: string,
  readings: readonly TestDirectoryReading[],
  into: TestGlob[],
): void {
  for (const reading of readings) {
    const base = { directory: ".", patterns: [reading.defaultMatch] };
    for (const { module } of read(dir, reading.files)) {
      for (const config of module.defaultExport) {
        const top = testDirectoryOf(config, reading, base);
        const projects = lastMember(config, reading.projects);
        if (top === undefined || projects === undefined) {
          continue;
        }
        const listed =
          projects === null ? [] : projects.kind === "array" ? projects.elements : [projects];
        const each =
          listed.length === 0 ? [top] : listed.map((one) => testDirectoryOf(one, reading, top));
        for (const found of each) {
          for (const pattern of found?.patterns ?? []) {
            const expression = anywhereBelow(pattern);
            into.push({
              dir: resolvePath(dir, found?.directory ?? "."),
              pattern,
              matches: (name) => expression.test(name.replace(/^\/+/u, "")),
            });
          }
        }
      }
    }
  }
}

/**
 * The expression a test-file pattern denotes over a file's whole path, as Playwright's
 * matcher reads it: a pattern gains a leading `**` segment unless it starts with one, and
 * case is not compared (https://github.com/microsoft/playwright/blob/main/packages/playwright/src/util.ts,
 * `createFileMatcher`).
 */
function anywhereBelow(pattern: string): RegExp {
  const expression = globExpression(pattern.startsWith("**/") ? pattern : `**/${pattern}`);
  return new RegExp(expression.source, "iu");
}

/** The strings an applied row's selection keys hold, added per configuration file to `into`. */
function selectedStrings(
  read: ReadFiles,
  dir: string,
  readings: readonly MoveReading[],
  into: Map<string, { starts: Set<number>; texts: string[] }>,
): void {
  for (const reading of readings) {
    for (const { name, module } of read(dir, reading.files)) {
      const path = joinPath(dir, name);
      const held = into.get(path) ?? { starts: new Set<number>(), texts: [] };
      for (const { text, at } of stringsAt(readObjects(module, reading.call), reading.property)) {
        if (at !== undefined) {
          held.starts.add(at);
        }
        held.texts.push(text);
      }
      into.set(path, held);
    }
  }
}

/**
 * The dependencies one manifest declares that a string at any depth of one of its members
 * names, alone or followed by `/` and a subpath, a member's name aside.
 */
function manifestKeyUses(manifest: unknown, keys: readonly string[]): readonly string[] {
  if (!isRecord(manifest)) {
    return [];
  }
  const declared = DEPENDENCY_SECTIONS.flatMap((section) => {
    const held = manifest[section];
    return isRecord(held) ? Object.keys(held) : [];
  });
  const strings = keys.flatMap((key) => documentStrings(manifest[key]));
  return declared.filter((name) =>
    strings.some((text) => text === name || text.startsWith(`${name}/`)),
  );
}

/** The extensions an entry a manifest entry key names without one may carry. */
const ENTRY_EXTENSIONS = braced(APPENDED_EXTENSIONS);

/** The characters that make a manifest string a pattern rather than a directory's name. */
const PATTERN = /[*?{}[\]]/u;

/**
 * The entry globs one applied row's manifest entry keys write, below the manifest's
 * directory: a directory's every module, or a file with or without an extension. A string
 * that leaves the directory names nothing.
 */
function manifestEntryGlobs(manifest: unknown, keys: readonly ManifestEntryKey[]): string[] {
  const at = (value: unknown, path: readonly string[]): unknown[] => {
    const [key, ...rest] = path;
    if (key === undefined) {
      return [value];
    }
    if (!isRecord(value)) {
      return [];
    }
    const next = key === "*" ? Object.values(value) : Object.hasOwn(value, key) ? [value[key]] : [];
    return next.flatMap((one) => at(one, rest));
  };
  return keys.flatMap(({ key, directory }) =>
    at(manifest, key.split(".")).flatMap((value) =>
      documentStrings(value).flatMap((text) => {
        const path = normalizePath(text)
          .replace(/^(?:\.\/)+/u, "")
          .replace(/\/+$/u, "");
        if (path === "" || path === ".." || path.startsWith("../") || path.startsWith("/")) {
          return [];
        }
        if (!directory) {
          return [path, `${path}.${ENTRY_EXTENSIONS}`];
        }
        return PATTERN.test(path) ? [] : [`${path}/**/*.${ENTRY_EXTENSIONS}`];
      }),
    ),
  );
}

/** What one configuration file states about one property. */
interface PropertyReading {
  /** The literal values the file sets the property to. */
  readonly values: readonly string[];
  /** Where the first value that is not a literal is written, where there is one. */
  readonly notLiteral?: NotLiteral;
}

/**
 * Every value one file writes at one property's path inside the objects it is read from:
 * the options argument of every call `call` names, or the file's default export. A string
 * literal or a template literal with no substitution is the value, and so is each element
 * of an array literal of them where `elements`. A read object, or an object along the
 * path, that is not written out as an object literal, or that spreads another object into
 * itself, is not a literal, and neither is any other value at the path.
 */
export function readProperty(
  module: StaticModule,
  property: string,
  call?: OptionsCall,
  elements = false,
): PropertyReading {
  const values: string[] = [];
  for (const object of readObjects(module, call)) {
    const notLiteral = readPath(object, property.split("."), values, elements);
    if (notLiteral !== undefined) {
      return { values, notLiteral };
    }
  }
  return { values };
}

/** A directory below a manifest's, `.` for the directory itself, `undefined` outside it. */
function below(dir: string, path: string): string | undefined {
  return normalizePath(path) === normalizePath(dir) ? "." : relativePath(dir, path);
}

/**
 * Every text a template stands for, each placeholder replaced by every directory its move
 * resolved to. A placeholder whose move resolved outside the manifest's directory leaves
 * the text standing for nothing.
 */
function expand(
  template: string,
  resolved: ReadonlyMap<string, readonly (string | undefined)[]>,
): readonly string[] {
  const match = /<([A-Za-z]+)>/u.exec(template);
  if (match === null) {
    return [template];
  }
  const [placeholder, id = ""] = match;
  const out: string[] = [];
  for (const value of resolved.get(id) ?? []) {
    if (value === undefined) {
      continue;
    }
    const replaced =
      value === "." && template.startsWith(`${placeholder}/`, match.index)
        ? template.replace(`${placeholder}/`, "")
        : template.replace(placeholder, value);
    out.push(...expand(replaced, resolved));
  }
  return out;
}

/** The configuration files in one directory that one glob names, by name. */
function configurationFiles(host: Host, dir: string, glob: string): readonly string[] {
  const expression = globExpression(glob);
  return filesIn(host, dir, (name) => expression.test(name));
}

/** What one move resolved to: its directories, or the failure its property met. */
type MoveResult = { readonly dirs: readonly (string | undefined)[] } | { readonly failure: string };

function resolveMove(
  read: ReadFiles,
  dir: string,
  row: ConventionRow,
  move: DirectoryMove,
  resolved: ReadonlyMap<string, readonly (string | undefined)[]>,
): MoveResult {
  const set: string[] = [];
  for (const reading of move.readings) {
    for (const { name, text, module } of read(dir, reading.files)) {
      const read = readProperty(module, reading.property, reading.call);
      if (read.notLiteral !== undefined) {
        const { at } = read.notLiteral;
        const where = at === undefined ? name : `${name}:${String(lineOf(text, at))}`;
        return {
          failure:
            `${where} sets ${reading.property}, which moves a directory ` +
            `the convention row ${row.name} reads, to a value that is not a string literal: ` +
            `write it as a literal, or name ${row.name} in ts.disabled_conventions and its ` +
            `files in ts.entry_files`,
        };
      }
      set.push(...read.values);
    }
  }
  const dirs: (string | undefined)[] = [];
  for (const base of expand(move.base ?? ".", resolved)) {
    const against = joinPath(dir, base);
    const texts = set.length > 0 ? set : move.defaults.flatMap((one) => expand(one, resolved));
    for (const text of texts) {
      dirs.push(below(dir, resolvePath(against, text)));
    }
  }
  return { dirs: [...new Set(dirs)] };
}

/** One configuration file a reading names, read as a static module. */
interface ReadFile {
  readonly name: string;
  readonly text: string;
  readonly module: StaticModule;
}

/** The configuration files in one directory a reading's globs name, in name order. */
type ReadFiles = (dir: string, files: readonly string[]) => readonly ReadFile[];

/** A reader that reads and parses each configuration file once for every row and reading of a run. */
function readFilesOnce(host: Host, parse: ParseSource): ReadFiles {
  const read = new Map<string, ReadFile | undefined>();
  const readOne = (dir: string, name: string): ReadFile | undefined => {
    const path = joinPath(dir, name);
    if (read.has(path)) {
      return read.get(path);
    }
    let found: ReadFile | undefined;
    try {
      const text = host.readFile(path);
      if (YAML_NAME.test(name)) {
        const value = yamlDocument(text);
        found = value === undefined ? undefined : { name, text, module: documentModule(value) };
      } else {
        const file = parse(JSON_NAME.test(name) ? `${path}.json` : path, text);
        found = { name, text, module: staticModule(file) };
      }
    } catch {
      found = undefined;
    }
    read.set(path, found);
    return found;
  };
  return (dir, files) =>
    files.flatMap((glob) =>
      configurationFiles(host, dir, glob).flatMap((name) => readOne(dir, name) ?? []),
    );
}

/**
 * The dependencies one manifest declares that an applied row's short names use: the
 * package each literal value stands for, and, for a value that is not a literal, every
 * declared dependency the row's package name stands for with some value.
 */
function shortNameUses(
  read: ReadFiles,
  dir: string,
  manifest: unknown,
  readings: readonly ShortNameReading[],
): readonly string[] {
  const declared = new Set(
    DEPENDENCY_SECTIONS.flatMap((section) => {
      const held = isRecord(manifest) ? manifest[section] : undefined;
      return isRecord(held) ? Object.keys(held) : [];
    }),
  );
  const used = new Set<string>();
  for (const reading of readings) {
    const [before = "", after = ""] = reading.package.split("{}");
    for (const { module } of read(dir, reading.files)) {
      const read = readProperty(module, reading.property, reading.call, true);
      for (const value of read.values) {
        used.add(`${before}${value}${after}`);
      }
      if (read.notLiteral !== undefined) {
        for (const name of declared) {
          if (
            name.length >= before.length + after.length &&
            name.startsWith(before) &&
            name.endsWith(after)
          ) {
            used.add(name);
          }
        }
      }
    }
  }
  return [...used].filter((name) => declared.has(name)).sort(bytewise);
}

/**
 * The package one value of a prefixed-name reading names, or none: ESLint's own naming,
 * https://github.com/eslint/eslintrc/blob/main/lib/shared/naming.js
 */
function prefixedPackage(value: string, reading: PrefixedNameReading): string | undefined {
  const { prefix, marker } = reading;
  let name: string;
  if (marker === undefined) {
    if (value.includes(":") || value.startsWith(".") || value.startsWith("/")) {
      return undefined;
    }
    const parts = value.split("/");
    name = (value.startsWith("@") ? parts.slice(0, 2) : parts.slice(0, 1)).join("/");
  } else {
    if (!value.startsWith(marker) || !value.includes("/", marker.length)) {
      return undefined;
    }
    name = value.slice(marker.length, value.lastIndexOf("/"));
  }
  if (name === "") {
    return undefined;
  }
  if (!name.startsWith("@")) {
    return name.startsWith(`${prefix}-`) ? name : `${prefix}-${name}`;
  }
  const [scope, rest] = name.split("/");
  if (rest === undefined || rest === "" || rest === prefix) {
    return `${scope ?? name}/${prefix}`;
  }
  return rest.startsWith(`${prefix}-`) ? name : `${scope ?? name}/${prefix}-${rest}`;
}

/** The declared dependencies an applied row's prefixed names use. */
function prefixedNameUses(
  read: ReadFiles,
  dir: string,
  manifest: unknown,
  readings: readonly PrefixedNameReading[],
): readonly string[] {
  const declared = new Set(
    DEPENDENCY_SECTIONS.flatMap((section) => {
      const held = isRecord(manifest) ? manifest[section] : undefined;
      return isRecord(held) ? Object.keys(held) : [];
    }),
  );
  const used = new Set<string>();
  for (const reading of readings) {
    for (const { module } of read(dir, reading.files)) {
      for (const value of readProperty(module, reading.property, reading.call, true).values) {
        const named = prefixedPackage(value, reading);
        if (named !== undefined && declared.has(named)) {
          used.add(named);
        }
      }
    }
  }
  return [...used].sort(bytewise);
}

/** The declared dependencies an applied row's helper settings use. */
function helperUses(
  read: ReadFiles,
  dir: string,
  manifest: unknown,
  readings: readonly HelperReading[],
): readonly string[] {
  const declared = new Set(
    DEPENDENCY_SECTIONS.flatMap((section) => {
      const held = isRecord(manifest) ? manifest[section] : undefined;
      return isRecord(held) ? Object.keys(held) : [];
    }),
  );
  return readings
    .filter(
      (reading) =>
        declared.has(reading.package) &&
        read(dir, reading.files).some(({ module }) =>
          valuesAt(readObjects(module, reading.call), reading.property.split(".")).some((held) =>
            holdsValue(held, reading.value),
          ),
        ),
    )
    .map((reading) => reading.package);
}

/**
 * The dependencies one manifest declares that an applied row's package keys use: each
 * whose name a string under a member of a key's name equals, or begins followed by `/` or
 * by `:` and a name. A member's own name is no such string.
 */
function packageKeyUses(
  read: ReadFiles,
  dir: string,
  manifest: unknown,
  keys: readonly PackageKey[],
): readonly string[] {
  const declared = DEPENDENCY_SECTIONS.flatMap((section) => {
    const held = isRecord(manifest) ? manifest[section] : undefined;
    return isRecord(held) ? Object.keys(held) : [];
  });
  const strings: string[] = [];
  const children = (value: Value): readonly Value[] =>
    value.kind === "object"
      ? value.members.map((member) => member.value)
      : value.kind === "array"
        ? value.elements
        : [];
  const collect = (value: Value): void => {
    if (value.kind === "text") {
      strings.push(value.text);
    }
    children(value).forEach(collect);
  };
  for (const { key, files } of keys) {
    const visit = (value: Value): void => {
      if (value.kind === "object") {
        value.members
          .filter((member) => member.key === key)
          .forEach((member) => {
            collect(member.value);
          });
      }
      children(value).forEach(visit);
    };
    for (const { module } of read(dir, files)) {
      module.defaultExport.forEach(visit);
    }
  }
  return declared.filter((name) =>
    strings.some(
      (text) =>
        text === name ||
        text.startsWith(`${name}/`) ||
        (text.startsWith(`${name}:`) && text.length > name.length + 1),
    ),
  );
}

/** Every simple command of a manifest's `scripts`, as the command reader reads it in the manifest's directory. */
function scriptCommands(manifest: unknown, dir: string): readonly ScriptCommand[] {
  const scripts = isRecord(manifest) ? manifest["scripts"] : undefined;
  return isRecord(scripts)
    ? Object.values(scripts).flatMap((text) =>
        typeof text === "string" ? readCommands(text, dir).commands : [],
      )
    : [];
}

/**
 * What the rows decide over the manifests the analysis reads. A row `disabled` names
 * is skipped before anything is read for it.
 */
export function readConventions(
  host: Host,
  parse: ParseSource,
  manifests: readonly ConventionManifest[],
  disabled: readonly string[],
  rows: readonly ConventionRow[] = CONVENTION_ROWS,
): Conventions {
  const applied: AppliedConvention[] = [];
  const globs: ConventionGlob[] = [];
  const generated: GeneratedDirectory[] = [];
  const failures: ConventionFailure[] = [];
  const uses = new Set<string>();
  const selected = new Map<string, { starts: Set<number>; texts: string[] }>();
  const testFiles = new Map<string, string>();
  const testGlobs: TestGlob[] = [];
  const read = readFilesOnce(host, parse);
  for (const manifest of manifests) {
    const declared = readJSON(host, joinPath(manifest.dir, MANIFEST));
    let input: RunnerInput | undefined;
    const runnerInput = (): RunnerInput => {
      input ??= {
        host,
        dir: manifest.dir,
        manifest: declared,
        configuration: (dir, names) => {
          for (const name of names) {
            const [found] = read(dir, [name]);
            if (found !== undefined) {
              return { dir, module: found.module };
            }
          }
          return undefined;
        },
        scripts: scriptCommands(declared, manifest.dir),
      };
      return input;
    };
    const versions = new Map<string, string | undefined>();
    const missing = new Set<string>();
    for (const row of rows) {
      if (disabled.includes(row.name) || !declares(declared, row.package)) {
        continue;
      }
      if (!versions.has(row.package)) {
        versions.set(row.package, installedVersion(host, manifest.dir, row.package));
      }
      const version = versions.get(row.package);
      if (version === undefined) {
        if (
          missing.has(row.package) ||
          manifest.nested === true ||
          !declares(declared, row.package, REQUIRED_SECTIONS)
        ) {
          continue;
        }
        missing.add(row.package);
        failures.push({
          dir: manifest.dir,
          failure: {
            failureClass: "missing-module",
            detail:
              `${manifest.path} declares ${row.package}, which no node_modules at or ` +
              `above its directory holds: run the package manager's install`,
          },
        });
        continue;
      }
      if (!satisfies(version, row.range)) {
        continue;
      }
      const resolved = new Map<string, readonly (string | undefined)[]>();
      let failed: string | undefined;
      for (const move of row.moves) {
        const result = resolveMove(read, manifest.dir, row, move, resolved);
        if ("failure" in result) {
          failed = result.failure;
          break;
        }
        resolved.set(move.id, result.dirs);
      }
      if (failed !== undefined) {
        const where = dirnamePath(manifest.path);
        failures.push({
          dir: manifest.dir,
          failure: {
            failureClass: "convention-not-literal",
            detail: where === "." ? failed : `${where}/${failed}`,
          },
        });
        continue;
      }
      applied.push({
        name: row.name,
        package: row.package,
        version,
        manifest: manifest.path,
      });
      for (const name of shortNameUses(read, manifest.dir, declared, row.shortNames ?? [])) {
        uses.add(name);
      }
      const prefixed = row.prefixedNames ?? [];
      for (const name of prefixedNameUses(read, manifest.dir, declared, prefixed)) {
        uses.add(name);
      }
      const keys = row.packageKeys ?? [];
      for (const name of packageKeyUses(read, manifest.dir, declared, keys)) {
        uses.add(name);
      }
      for (const name of manifestKeyUses(declared, row.manifestKeys ?? [])) {
        uses.add(name);
      }
      for (const name of helperUses(read, manifest.dir, declared, row.helpers ?? [])) {
        uses.add(name);
      }
      selectedStrings(read, manifest.dir, row.selections ?? [], selected);
      testFilesNamed(read, manifest.dir, row.testFiles ?? [], testFiles, selected);
      testDirectoryGlobs(read, manifest.dir, row.testDirectories ?? [], testGlobs);
      testGlobs.push(...(row.testRunner?.(runnerInput()) ?? []));
      const excludes = [
        ...new Set((row.excludes ?? []).flatMap((one) => expand(one, resolved))),
      ].map(globExpression);
      for (const below of new Set((row.generated ?? []).flatMap((one) => expand(one, resolved)))) {
        generated.push({ dir: manifest.dir, row: row.name, below });
      }
      const written = [
        ...row.entries.flatMap((entry) => expand(entry, resolved)),
        ...manifestEntryGlobs(declared, row.manifestEntries ?? []),
      ];
      for (const glob of new Set(written)) {
        globs.push({
          dir: manifest.dir,
          row: row.name,
          expression: globExpression(glob),
          excludes,
        });
      }
    }
    testGlobs.push(...nodeTestGlobs(runnerInput().scripts));
  }
  const unique = [...new Map(applied.map((one) => [JSON.stringify(one), one])).values()];
  unique.sort(
    (a, b) =>
      bytewise(a.name, b.name) ||
      bytewise(a.manifest, b.manifest) ||
      bytewise(JSON.stringify(a), JSON.stringify(b)),
  );
  return {
    applied: unique,
    globs,
    generated,
    failures,
    uses: [...uses].sort(bytewise),
    selected,
    testFiles,
    testGlobs,
  };
}

/**
 * The files, absolute, of one project an applied row names as test files, each with the
 * string or the pattern that names it.
 */
export function conventionTestFiles(
  conventions: Conventions,
  files: SourceFiles,
): ReadonlyMap<string, string> {
  const found = new Map(conventions.testFiles);
  for (const { dir, pattern, matches } of conventions.testGlobs) {
    for (const file of files.byName.values()) {
      if (
        relativePath(dir, file.fileName) !== undefined &&
        matches(file.fileName) &&
        !found.has(file.fileName)
      ) {
        found.set(file.fileName, pattern);
      }
    }
  }
  return found;
}

/**
 * Every own file of one project below a directory an applied row names as generated, by
 * its path below the target root, with the name of the first such row.
 */
export function generatedFiles(
  conventions: Conventions,
  files: SourceFiles,
): ReadonlyMap<string, string> {
  const found = new Map<string, string>();
  for (const { dir, row, below } of conventions.generated) {
    const root = joinPath(dir, below);
    for (const [path, file] of files.byPath) {
      if (!found.has(path) && relativePath(root, file.fileName) !== undefined) {
        found.set(path, row);
      }
    }
  }
  return found;
}

/** Every own file of one project an applied row's globs match, once per row. */
export function conventionEntries(
  conventions: Conventions,
  files: SourceFiles,
): readonly ConventionEntry[] {
  const found = new Map<string, ConventionEntry>();
  for (const glob of conventions.globs) {
    for (const file of files.byName.values()) {
      const matched = [file.fileName, ...files.writtenAs(file)].some((name) => {
        const path = relativePath(glob.dir, name);
        return (
          path !== undefined &&
          glob.expression.test(path) &&
          !glob.excludes.some((one) => one.test(path))
        );
      });
      if (matched) {
        found.set(`${file.fileName}\u0000${glob.row}`, { file, row: glob.row });
      }
    }
  }
  return [...found.values()];
}

/**
 * The failures the rows met that hold for one configuration: those of a manifest whose
 * directory holds the configuration file or one of the files the project owns.
 */
export function conventionFailuresFor(
  conventions: Conventions,
  configFile: string,
  ownFiles: readonly string[],
): readonly Failure[] {
  return conventions.failures
    .filter(
      ({ dir }) =>
        below(dir, dirnamePath(configFile)) !== undefined ||
        ownFiles.some((file) => relativePath(dir, file) !== undefined),
    )
    .map(({ failure }) => failure);
}
