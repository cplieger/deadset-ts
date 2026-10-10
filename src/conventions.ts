/**
 * The convention rows a run applies, and the files they root. A row applies to a
 * manifest that declares its enabling package when the installed package's version is
 * in the row's range; its globs are read against that manifest's directory, with every
 * directory a configuration property moves read from the property's literal value.
 * No configuration file is run.
 */

import {
  isArrayLiteralExpression,
  isAsExpression,
  isBinaryExpression,
  isCallExpression,
  isClassDeclaration,
  isComputedPropertyName,
  isExportAssignment,
  isExportDeclaration,
  isExpressionStatement,
  isFunctionDeclaration,
  isIdentifier,
  isImportDeclaration,
  isNamedExports,
  isNamespaceImport,
  isNoSubstitutionTemplateLiteral,
  isNonNullExpression,
  isNumericLiteral,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSatisfiesExpression,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isStringLiteral,
  isVariableStatement,
  SyntaxKind,
  type AsExpression,
  type Identifier,
  type Node,
  type ObjectBindingPattern,
  type NonNullExpression,
  type ObjectLiteralExpression,
  type ParenthesizedExpression,
  type SatisfiesExpression,
  type SourceFile,
} from "@typescript/native/unstable/ast";
import { lineOf } from "./component-files.ts";
import {
  CONVENTION_ROWS,
  type ConventionRow,
  type DirectoryMove,
  type HelperReading,
  type MoveReading,
  type OptionsCall,
  type PackageKey,
  type ShortNameReading,
  type TestFileReading,
} from "./convention-rows.ts";
import { documentStrings } from "./configuration-files.ts";
import { globExpression } from "./glob.ts";
import type { Host } from "./host.ts";
import { dirnamePath, joinPath, normalizePath, relativePath, resolvePath } from "./paths.ts";
import type { SetupFailure } from "./setup-failure.ts";
import type { SourceFiles } from "./source-files.ts";
import { satisfies } from "./version-range.ts";

/** One manifest the analysis reads. */
export interface ConventionManifest {
  /** The manifest's directory, absolute. */
  readonly dir: string;
  /** The manifest's path below the target root, `/`-separated. */
  readonly path: string;
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
  readonly failure: SetupFailure;
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
  /** The files, absolute, an applied row's test-file properties name. */
  readonly testFiles: ReadonlySet<string>;
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

const JSON_EXTENSION = ".json";

/** A configuration file with no extension that its tool reads as a JSON document. */
const JSON_RC = /^\.[\w-]+rc$/u;

/** The sections an installed package is required by, so its absence fails the run. */
const REQUIRED_SECTIONS = ["dependencies", "devDependencies"] as const;

const DEPENDENCY_SECTIONS = [
  ...REQUIRED_SECTIONS,
  "peerDependencies",
  "optionalDependencies",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJSON(host: Host, path: string): unknown {
  try {
    return JSON.parse(host.readFile(path));
  } catch {
    return undefined;
  }
}

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
  for (let at = normalizePath(dir); ; at = dirnamePath(at)) {
    const path = joinPath(at, "node_modules", name, "package.json");
    if (host.kindOf(path) === "file") {
      const manifest = readJSON(host, path);
      const version = isRecord(manifest) ? manifest["version"] : undefined;
      return typeof version === "string" ? version : "";
    }
    if (dirnamePath(at) === at) {
      return undefined;
    }
  }
}

/** Whether one node wraps an expression without changing its value. */
function isWrapper(
  node: Node,
): node is ParenthesizedExpression | AsExpression | SatisfiesExpression | NonNullExpression {
  return (
    isParenthesizedExpression(node) ||
    isAsExpression(node) ||
    isSatisfiesExpression(node) ||
    isNonNullExpression(node)
  );
}

/** The expression a wrapper that changes no value holds. */
function unwrapped(node: Node): Node {
  let at = node;
  while (isWrapper(at)) {
    at = at.expression;
  }
  return at;
}

/** The key one property is written with, where it is written as a name or as literal text. */
function keyOf(property: Node): string | undefined {
  if (!isPropertyAssignment(property) && !isShorthandPropertyAssignment(property)) {
    return undefined;
  }
  const { name } = property;
  const key = isComputedPropertyName(name) ? name.expression : name;
  if (
    (isIdentifier(key) && key === name) ||
    isStringLiteral(key) ||
    isNoSubstitutionTemplateLiteral(key)
  ) {
    return key.text;
  }
  return undefined;
}

/** Whether one member's computed name is no literal, so it may set any key. */
function computesKey(member: Node): boolean {
  const name = (member as { readonly name?: Node }).name;
  if (name === undefined || !isComputedPropertyName(name)) {
    return false;
  }
  const key = name.expression;
  return !(isStringLiteral(key) || isNumericLiteral(key) || isNoSubstitutionTemplateLiteral(key));
}

/** The values one file's top-level variable declarations bind, by name. */
function declaredValues(file: SourceFile): ReadonlyMap<string, Node> {
  const values = new Map<string, Node>();
  for (const statement of file.statements) {
    if (isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (isIdentifier(declaration.name) && declaration.initializer !== undefined) {
          values.set(declaration.name.text, declaration.initializer);
        }
      }
    }
  }
  return values;
}

function isModuleExports(node: Node): boolean {
  return (
    isPropertyAccessExpression(node) &&
    isIdentifier(node.expression) &&
    node.expression.text === "module" &&
    node.name.text === "exports"
  );
}

/**
 * Every expression or declaration one file exports as its default, in any module syntax.
 * A JSON module's default export is its document's value.
 */
function defaultExports(file: SourceFile): readonly Node[] {
  if (file.fileName.endsWith(JSON_EXTENSION)) {
    return file.statements.flatMap((statement) =>
      isExpressionStatement(statement) ? [statement.expression] : [],
    );
  }
  const found: Node[] = [];
  for (const statement of file.statements) {
    if (isExportAssignment(statement)) {
      found.push(statement.expression);
    } else if (
      (isFunctionDeclaration(statement) || isClassDeclaration(statement)) &&
      statement.modifiers?.some((one) => one.kind === SyntaxKind.DefaultKeyword) === true
    ) {
      found.push(statement);
    } else if (
      isExportDeclaration(statement) &&
      statement.moduleSpecifier === undefined &&
      statement.exportClause !== undefined &&
      isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        if (element.name.text === "default") {
          found.push(element.propertyName ?? element.name);
        }
      }
    } else if (
      isExpressionStatement(statement) &&
      isBinaryExpression(statement.expression) &&
      statement.expression.operatorToken.kind === SyntaxKind.EqualsToken &&
      isModuleExports(statement.expression.left)
    ) {
      found.push(statement.expression.right);
    }
  }
  return found;
}

/** The declarations whose name is a binding of the scope they are written in. */
const BINDING_KINDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.VariableDeclaration,
  SyntaxKind.Parameter,
  SyntaxKind.BindingElement,
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.ClassDeclaration,
  SyntaxKind.ImportClause,
  SyntaxKind.ImportSpecifier,
  SyntaxKind.NamespaceImport,
  SyntaxKind.ImportEqualsDeclaration,
]);

/** Whether one file declares a binding named `require` at any depth, which shadows the global. */
function declaresRequire(file: SourceFile): boolean {
  let found = false;
  const visit = (node: Node): void => {
    const name = (node as { readonly name?: Node }).name;
    if (
      name !== undefined &&
      isIdentifier(name) &&
      name.text === "require" &&
      BINDING_KINDS.has(node.kind)
    ) {
      found = true;
    }
    if (!found) {
      node.forEachChild(visit);
    }
  };
  file.forEachChild(visit);
  return found;
}

/**
 * The top-level `const`, `let` and `var` declarations that bind a `require` of one module,
 * written with the module's name as its one string-literal argument, in a file that
 * declares no binding named `require`: each binds as an import of the module does.
 */
function requireBindings(
  file: SourceFile,
  module: string,
): readonly (Identifier | ObjectBindingPattern)[] {
  const found: (Identifier | ObjectBindingPattern)[] = [];
  for (const statement of file.statements) {
    if (!isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      const value =
        declaration.initializer === undefined ? undefined : unwrapped(declaration.initializer);
      const [argument, ...rest] =
        value !== undefined && isCallExpression(value) ? value.arguments : [];
      if (
        value === undefined ||
        !isCallExpression(value) ||
        !isIdentifier(value.expression) ||
        value.expression.text !== "require" ||
        argument === undefined ||
        rest.length > 0 ||
        !isStringLiteral(argument) ||
        argument.text !== module
      ) {
        continue;
      }
      if (isIdentifier(declaration.name) || isObjectBindingPattern(declaration.name)) {
        found.push(declaration.name);
      }
    }
  }
  return found.length > 0 && declaresRequire(file) ? [] : found;
}

/**
 * The first argument of every call one file makes to one module's export, through a
 * named or a namespace import; `undefined` for a call with no argument.
 */
function optionsArguments(file: SourceFile, call: OptionsCall): readonly (Node | undefined)[] {
  const names = new Set<string>();
  const namespaces = new Set<string>();
  for (const name of requireBindings(file, call.module)) {
    if (isIdentifier(name)) {
      namespaces.add(name.text);
      continue;
    }
    for (const element of name.elements) {
      const local = element.name;
      const exported = element.propertyName ?? local;
      if (
        element.dotDotDotToken === undefined &&
        local !== undefined &&
        isIdentifier(local) &&
        exported !== undefined &&
        (isIdentifier(exported) || isStringLiteral(exported)) &&
        exported.text === call.export
      ) {
        names.add(local.text);
      }
    }
  }
  for (const statement of file.statements) {
    const bindings = isImportDeclaration(statement)
      ? statement.importClause?.namedBindings
      : undefined;
    if (
      bindings === undefined ||
      !isImportDeclaration(statement) ||
      !isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== call.module
    ) {
      continue;
    }
    if (isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      continue;
    }
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === call.export) {
        names.add(element.name.text);
      }
    }
  }
  const found: (Node | undefined)[] = [];
  const visit = (node: Node): void => {
    if (isCallExpression(node)) {
      const callee = unwrapped(node.expression);
      const named = isIdentifier(callee) && names.has(callee.text);
      const throughNamespace =
        isPropertyAccessExpression(callee) &&
        isIdentifier(callee.expression) &&
        namespaces.has(callee.expression.text) &&
        callee.name.text === call.export;
      if (named || throughNamespace) {
        found.push(node.arguments[0]);
      }
    }
    node.forEachChild(visit);
  };
  file.forEachChild(visit);
  return found;
}

/**
 * The object literal one expression stands for, read through the file's top-level
 * declarations and, where `throughCalls`, through a call's first argument: `undefined`
 * for a call with no argument, and any other node where the expression is not written
 * out as an object literal.
 */
function objectOf(
  node: Node,
  declared: ReadonlyMap<string, Node>,
  throughCalls: boolean,
  seen: ReadonlySet<string> = new Set(),
): Node | undefined {
  const at = unwrapped(node);
  if (isIdentifier(at)) {
    const value = declared.get(at.text);
    if (value !== undefined && !seen.has(at.text)) {
      return objectOf(value, declared, throughCalls, new Set([...seen, at.text]));
    }
  } else if (throughCalls && isCallExpression(at)) {
    const [first] = at.arguments;
    return first === undefined ? undefined : objectOf(first, declared, throughCalls, seen);
  }
  return at;
}

/** The text of a string literal or a template literal with no substitution, or undefined. */
function literalText(node: Node): string | undefined {
  const at = unwrapped(node);
  return isStringLiteral(at) || isNoSubstitutionTemplateLiteral(at) ? at.text : undefined;
}

/**
 * The literal texts one value at a path's end writes: the literal itself, or, where
 * `elements`, each element of an array literal of literals. Undefined for any other value.
 */
function literalTexts(held: Node, elements: boolean): readonly string[] | undefined {
  const one = literalText(held);
  if (one !== undefined) {
    return [one];
  }
  if (!elements || !isArrayLiteralExpression(held)) {
    return undefined;
  }
  const texts = held.elements.map(literalText);
  return texts.every((text) => text !== undefined) ? texts : undefined;
}

/**
 * Reads the values at one path of keys below one object literal into `values`, and
 * answers the first member that does not write its value out: a spread, a value that is
 * not a literal at the path's end, or one that is not an object literal before it.
 */
function readPath(
  object: ObjectLiteralExpression,
  keys: readonly string[],
  values: string[],
  elements: boolean,
): Node | undefined {
  const [key, ...rest] = keys;
  for (const member of object.properties) {
    if (isSpreadAssignment(member) || computesKey(member)) {
      return member;
    }
    if (keyOf(member) !== key) {
      continue;
    }
    const held = isPropertyAssignment(member) ? unwrapped(member.initializer) : undefined;
    if (rest.length === 0) {
      const texts = held === undefined ? undefined : literalTexts(held, elements);
      if (texts === undefined) {
        return member;
      }
      values.push(...texts);
    } else {
      if (held === undefined || !isObjectLiteralExpression(held)) {
        return member;
      }
      const failed = readPath(held, rest, values, elements);
      if (failed !== undefined) {
        return failed;
      }
    }
  }
  return undefined;
}

/**
 * Every value one file writes at one property's path inside the objects it is read from,
 * as {@link readProperty} reads them, whatever else the path holds.
 */
function valuesAt(file: SourceFile, property: string, call?: OptionsCall): readonly Node[] {
  const declared = declaredValues(file);
  const objects =
    call === undefined
      ? defaultExports(file).map((one) => objectOf(one, declared, true))
      : optionsArguments(file, call).map((one) =>
          one === undefined ? undefined : objectOf(one, declared, false),
        );
  const found: Node[] = [];
  const visit = (object: Node, keys: readonly string[]): void => {
    if (!isObjectLiteralExpression(object)) {
      return;
    }
    const [key, ...rest] = keys;
    for (const member of object.properties) {
      if (!isPropertyAssignment(member) || keyOf(member) !== key) {
        continue;
      }
      const held = unwrapped(member.initializer);
      if (rest.length > 0) {
        visit(held, rest);
      } else {
        found.push(held);
      }
    }
  };
  for (const object of objects) {
    if (object !== undefined) {
      visit(object, property.split("."));
    }
  }
  return found;
}

/** The string literals among values: each value itself, or each element of an array value. */
function stringsAt(file: SourceFile, property: string, call?: OptionsCall): readonly Node[] {
  return valuesAt(file, property, call).flatMap((held) => {
    if (literalText(held) !== undefined) {
      return [held];
    }
    return isArrayLiteralExpression(held)
      ? held.elements.map(unwrapped).filter((one) => literalText(one) !== undefined)
      : [];
  });
}

/** Whether one value holds a helper setting's value, as {@link HelperReading} states it. */
function holdsValue(held: Node, value: true | string): boolean {
  if (value === true) {
    return held.kind === SyntaxKind.TrueKeyword;
  }
  if (literalText(held) === value) {
    return true;
  }
  return (
    isArrayLiteralExpression(held) &&
    held.elements.some((element) => {
      const one = unwrapped(element);
      const first = isArrayLiteralExpression(one) ? one.elements[0] : one;
      return first !== undefined && literalText(first) === value;
    })
  );
}

/** The directory one file's test-file strings are read against, as {@link TestFileReading} states it. */
function testFileRoot(file: SourceFile, dir: string, reading: TestFileReading): string | undefined {
  for (const property of reading.roots) {
    const values = valuesAt(file, property, reading.call);
    if (values.length > 0) {
      const texts = new Set(values.map(literalText));
      const [text] = texts;
      return texts.size === 1 && text !== undefined ? resolvePath(dir, text) : undefined;
    }
  }
  return dir;
}

/** The files an applied row's test-file properties name. */
function testFilesNamed(
  host: Host,
  parse: ParseSource,
  dir: string,
  readings: readonly TestFileReading[],
  into: Set<string>,
): void {
  for (const reading of readings) {
    for (const { file } of readingFiles(host, parse, dir, reading.files)) {
      const at = testFileRoot(file, dir, reading);
      if (at === undefined) {
        continue;
      }
      for (const node of stringsAt(file, reading.property, reading.call)) {
        const text = literalText(node);
        if (text !== undefined && text !== "") {
          into.add(resolvePath(at, text));
        }
      }
    }
  }
}

/** The strings an applied row's selection keys hold, added per configuration file to `into`. */
function selectedStrings(
  host: Host,
  parse: ParseSource,
  dir: string,
  readings: readonly MoveReading[],
  into: Map<string, { starts: Set<number>; texts: string[] }>,
): void {
  for (const reading of readings) {
    for (const { name, file } of readingFiles(host, parse, dir, reading.files)) {
      const path = joinPath(dir, name);
      const held = into.get(path) ?? { starts: new Set<number>(), texts: [] };
      for (const node of stringsAt(file, reading.property, reading.call)) {
        held.starts.add(node.getStart());
        held.texts.push(literalText(node) ?? "");
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

/** What one configuration file states about one property. */
interface PropertyReading {
  /** The literal values the file sets the property to. */
  readonly values: readonly string[];
  /** The position of the first value that is not a literal, where there is one. */
  readonly notLiteral?: Node;
}

/**
 * Every value one file writes at one property's path inside the object it is read from:
 * the options argument of every call `call` names, or the file's default export. A string
 * literal or a template literal with no substitution is the value, and so is each element
 * of an array literal of them where `elements`. A read object, or an object along the
 * path, that is not written out as an object literal, or that spreads another object into
 * itself, is not a literal, and neither is any other value at the path.
 */
export function readProperty(
  file: SourceFile,
  property: string,
  call?: OptionsCall,
  elements = false,
): PropertyReading {
  const declared = declaredValues(file);
  const objects =
    call === undefined
      ? defaultExports(file).map((one) => objectOf(one, declared, true))
      : optionsArguments(file, call).map((one) =>
          one === undefined ? undefined : objectOf(one, declared, false),
        );
  const values: string[] = [];
  for (const object of objects) {
    if (object === undefined) {
      continue;
    }
    const notLiteral = isObjectLiteralExpression(object)
      ? readPath(object, property.split("."), values, elements)
      : object;
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
  let entries;
  try {
    entries = host.readDirectory(dir);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => !entry.directory && expression.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/** What one move resolved to: its directories, or the failure its property met. */
type MoveResult = { readonly dirs: readonly (string | undefined)[] } | { readonly failure: string };

function resolveMove(
  host: Host,
  parse: ParseSource,
  dir: string,
  row: ConventionRow,
  move: DirectoryMove,
  resolved: ReadonlyMap<string, readonly (string | undefined)[]>,
): MoveResult {
  const set: string[] = [];
  for (const reading of move.readings) {
    for (const { name, text, file } of readingFiles(host, parse, dir, reading.files)) {
      const read = readProperty(file, reading.property, reading.call);
      if (read.notLiteral !== undefined) {
        const line = lineOf(text, read.notLiteral.getStart());
        return {
          failure:
            `${name}:${String(line)} sets ${reading.property}, which moves a directory ` +
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

/** The texts each configuration file a reading names holds, parsed, in name order. */
function readingFiles(
  host: Host,
  parse: ParseSource,
  dir: string,
  files: readonly string[],
): readonly { readonly name: string; readonly text: string; readonly file: SourceFile }[] {
  const found = [];
  for (const glob of files) {
    for (const name of configurationFiles(host, dir, glob)) {
      const path = joinPath(dir, name);
      let text: string;
      try {
        text = host.readFile(path);
      } catch {
        continue;
      }
      found.push({
        name,
        text,
        file: parse(JSON_RC.test(name) ? `${path}${JSON_EXTENSION}` : path, text),
      });
    }
  }
  return found;
}

/**
 * The dependencies one manifest declares that an applied row's short names use: the
 * package each literal value stands for, and, for a value that is not a literal, every
 * declared dependency the row's package name stands for with some value.
 */
function shortNameUses(
  host: Host,
  parse: ParseSource,
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
    for (const { file } of readingFiles(host, parse, dir, reading.files)) {
      const read = readProperty(file, reading.property, reading.call, true);
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
  return [...used].filter((name) => declared.has(name)).sort(compare);
}

/** The declared dependencies an applied row's helper settings use. */
function helperUses(
  host: Host,
  parse: ParseSource,
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
        readingFiles(host, parse, dir, reading.files).some(({ file }) =>
          valuesAt(file, reading.property, reading.call).some((held) =>
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
  host: Host,
  parse: ParseSource,
  dir: string,
  manifest: unknown,
  keys: readonly PackageKey[],
): readonly string[] {
  const declared = DEPENDENCY_SECTIONS.flatMap((section) => {
    const held = isRecord(manifest) ? manifest[section] : undefined;
    return isRecord(held) ? Object.keys(held) : [];
  });
  const strings: string[] = [];
  const collect = (node: Node): void => {
    const text = literalText(node);
    if (text !== undefined) {
      strings.push(text);
    } else if (isPropertyAssignment(node)) {
      collect(node.initializer);
    } else {
      node.forEachChild(collect);
    }
  };
  for (const { key, files } of keys) {
    const visit = (node: Node): void => {
      if (isPropertyAssignment(node) && keyOf(node) === key) {
        collect(node.initializer);
      }
      node.forEachChild(visit);
    };
    for (const { file } of readingFiles(host, parse, dir, files)) {
      const values = declaredValues(file);
      for (const one of defaultExports(file)) {
        const object = objectOf(one, values, true);
        if (object !== undefined) {
          visit(object);
        }
      }
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

/** Two strings ordered bytewise. */
function compare(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
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
  const testFiles = new Set<string>();
  for (const manifest of manifests) {
    const declared = readJSON(host, joinPath(manifest.dir, "package.json"));
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
        if (missing.has(row.package) || !declares(declared, row.package, REQUIRED_SECTIONS)) {
          continue;
        }
        missing.add(row.package);
        failures.push({
          dir: manifest.dir,
          failure: {
            setupClass: "missing-module",
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
        const result = resolveMove(host, parse, manifest.dir, row, move, resolved);
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
            setupClass: "convention-not-literal",
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
      for (const name of shortNameUses(host, parse, manifest.dir, declared, row.shortNames ?? [])) {
        uses.add(name);
      }
      const keys = row.packageKeys ?? [];
      for (const name of packageKeyUses(host, parse, manifest.dir, declared, keys)) {
        uses.add(name);
      }
      for (const name of manifestKeyUses(declared, row.manifestKeys ?? [])) {
        uses.add(name);
      }
      for (const name of helperUses(host, parse, manifest.dir, declared, row.helpers ?? [])) {
        uses.add(name);
      }
      selectedStrings(host, parse, manifest.dir, row.selections ?? [], selected);
      testFilesNamed(host, parse, manifest.dir, row.testFiles ?? [], testFiles);
      const excludes = [
        ...new Set((row.excludes ?? []).flatMap((one) => expand(one, resolved))),
      ].map(globExpression);
      for (const below of new Set((row.generated ?? []).flatMap((one) => expand(one, resolved)))) {
        generated.push({ dir: manifest.dir, row: row.name, below });
      }
      for (const glob of new Set(row.entries.flatMap((entry) => expand(entry, resolved)))) {
        globs.push({
          dir: manifest.dir,
          row: row.name,
          expression: globExpression(glob),
          excludes,
        });
      }
    }
  }
  const unique = [...new Map(applied.map((one) => [JSON.stringify(one), one])).values()];
  unique.sort(
    (a, b) =>
      compare(a.name, b.name) ||
      compare(a.manifest, b.manifest) ||
      compare(JSON.stringify(a), JSON.stringify(b)),
  );
  return {
    applied: unique,
    globs,
    generated,
    failures,
    uses: [...uses].sort(compare),
    selected,
    testFiles,
  };
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
      const path = relativePath(glob.dir, file.fileName);
      if (
        path !== undefined &&
        glob.expression.test(path) &&
        !glob.excludes.some((one) => one.test(path))
      ) {
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
): readonly SetupFailure[] {
  return conventions.failures
    .filter(
      ({ dir }) =>
        below(dir, dirnamePath(configFile)) !== undefined ||
        ownFiles.some((file) => relativePath(dir, file) !== undefined),
    )
    .map(({ failure }) => failure);
}
