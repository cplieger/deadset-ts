/**
 * What a module or a configuration document writes out, read without running it, as one
 * value model every entry source reads: a default export in each of its forms, the options
 * a call of one module's export passes, and the top-level values names stand for. A value
 * the text does not state is opaque, so no reader guesses it.
 */

import {
  isArrayLiteralExpression,
  isBindingElement,
  isExternalModuleReference,
  isImportClause,
  isImportEqualsDeclaration,
  isImportSpecifier,
  isStringLiteralLikeNode,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isComputedPropertyName,
  isExportAssignment,
  isExportDeclaration,
  isExpressionStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isFunctionLikeDeclaration,
  isIdentifier,
  isImportDeclaration,
  isNamedExports,
  isNamespaceImport,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSpreadAssignment,
  isStringLiteral,
  isVariableDeclaration,
  isVariableStatement,
  isSourceFile,
  isBlock,
  isModuleBlock,
  isCaseBlock,
  isCatchClause,
  isForStatement,
  isForInStatement,
  isForOfStatement,
  isVariableDeclarationList,
  isMetaProperty,
  isAssignmentOperator,
  isBinaryExpression,
  isParenthesizedExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isShorthandPropertyAssignment,
  isSpreadElement,
  NodeFlags,
  SyntaxKind,
  type CallExpression,
  type Node,
  type SourceFile,
} from "@typescript/native/ast";
import { commonJSModuleValue, type ModuleValue } from "../inventory/commonjs.ts";
import { callsPlatformBy, lexicalBinding, writtenName, type BindingOf } from "../platform-calls.ts";
import { unwrapped } from "../unwrap.ts";

/** Where a value's text starts in its file, or undefined in a document read with no positions. */
type At = number | undefined;

/** One member an object writes: its key, or undefined where a spread or a computed key hides it. */
interface Member {
  readonly key: string | undefined;
  readonly value: Value;
  readonly at: At;
}

/** One value a module's text states, or an opaque one it does not. */
export type Value =
  | { readonly kind: "text"; readonly text: string; readonly at: At }
  | { readonly kind: "boolean"; readonly value: boolean; readonly at: At }
  | { readonly kind: "array"; readonly elements: readonly Value[]; readonly at: At }
  | { readonly kind: "object"; readonly members: readonly Member[]; readonly at: At }
  | {
      /** A `resolve` or `join` of the module's own directory and literal segments. */
      readonly kind: "directory";
      readonly segments: readonly string[];
      readonly at: At;
    }
  | { readonly kind: "opaque"; readonly at: At };

/** A JSON or YAML document's value, which carries no positions. */
export function documentValue(value: unknown): Value {
  if (typeof value === "string") {
    return { kind: "text", text: value, at: undefined };
  }
  if (typeof value === "boolean") {
    return { kind: "boolean", value, at: undefined };
  }
  if (Array.isArray(value)) {
    return { kind: "array", elements: value.map(documentValue), at: undefined };
  }
  if (typeof value === "object" && value !== null) {
    return {
      kind: "object",
      members: Object.entries(value).map(([key, held]) => ({
        key,
        value: documentValue(held),
        at: undefined,
      })),
      at: undefined,
    };
  }
  return { kind: "opaque", at: undefined };
}

/**
 * The node that declares a name through one binding: the holder itself for a name, or the
 * binding element of an object or array pattern that binds it.
 */
function boundAt(holder: Node, name: Node | undefined, text: string): Node | undefined {
  if (name === undefined) {
    return undefined;
  }
  if (isIdentifier(name)) {
    return name.text === text ? holder : undefined;
  }
  let found: Node | undefined;
  name.forEachChild((element) => {
    found ??= boundAt(element, (element as { readonly name?: Node }).name, text);
  });
  return found;
}

/** The declaration of a name one statement makes in the block it is written in. */
function blockDeclaration(statement: Node, name: string): Node | undefined {
  if (
    (isFunctionDeclaration(statement) || isClassDeclaration(statement)) &&
    statement.name?.text === name
  ) {
    return statement;
  }
  if (
    isVariableStatement(statement) &&
    (statement.declarationList.flags & NodeFlags.BlockScoped) !== 0
  ) {
    return statement.declarationList.declarations
      .map((one) => boundAt(one, one.name, name))
      .find((one) => one !== undefined);
  }
  if (isImportEqualsDeclaration(statement)) {
    return statement.name.text === name ? statement : undefined;
  }
  if (isImportDeclaration(statement)) {
    const clause = statement.importClause;
    if (clause?.name?.text === name) {
      return clause;
    }
    const bindings = clause?.namedBindings;
    if (bindings !== undefined && isNamespaceImport(bindings)) {
      return bindings.name.text === name ? bindings : undefined;
    }
    return bindings?.elements.find((one) => one.name.text === name);
  }
  return undefined;
}

/** The `var` declaration of a name anywhere below one scope, outside every function nested in it. */
function varDeclaration(scope: Node, name: string): Node | undefined {
  let found: Node | undefined;
  const visit = (node: Node): void => {
    if (found !== undefined || isFunctionLikeDeclaration(node) || isClassLike(node)) {
      return;
    }
    if (isVariableDeclaration(node) && (node.parent.flags & NodeFlags.BlockScoped) === 0) {
      found = boundAt(node, node.name, name);
      if (found !== undefined) {
        return;
      }
    }
    node.forEachChild(visit);
  };
  scope.forEachChild(visit);
  return found;
}

function isClassLike(node: Node): boolean {
  return isClassDeclaration(node) || isClassExpression(node);
}

/** The statements a scope holds directly, for a block, a case block or a file. */
function statementsOf(scope: Node): readonly Node[] {
  if (isSourceFile(scope) || isBlock(scope) || isModuleBlock(scope)) {
    return scope.statements;
  }
  if (isCaseBlock(scope)) {
    return scope.clauses.flatMap((clause) => [...clause.statements]);
  }
  return [];
}

/** The declaration one scope makes of a name, ECMAScript's lexical and variable environments read from the syntax. */
function scopeDeclaration(scope: Node, name: string): Node | undefined {
  if (isFunctionLikeDeclaration(scope)) {
    const own =
      (isFunctionExpression(scope) || isFunctionDeclaration(scope)) && scope.name?.text === name
        ? isFunctionExpression(scope)
          ? scope
          : undefined
        : undefined;
    const parameter = scope.parameters
      .map((one) => boundAt(one, one.name, name))
      .find((one) => one !== undefined);
    const body = scope.body;
    return (
      parameter ??
      (body === undefined
        ? undefined
        : (statementsOf(body)
            .map((one) => blockDeclaration(one, name))
            .find(Boolean) ?? varDeclaration(body, name))) ??
      own
    );
  }
  if (isClassExpression(scope) && scope.name?.text === name) {
    return scope;
  }
  if (isCatchClause(scope)) {
    const caught = scope.variableDeclaration;
    return caught === undefined ? undefined : boundAt(caught, caught.name, name);
  }
  if (isForStatement(scope) || isForInStatement(scope) || isForOfStatement(scope)) {
    const list = scope.initializer;
    return list !== undefined &&
      isVariableDeclarationList(list) &&
      (list.flags & NodeFlags.BlockScoped) !== 0
      ? list.declarations
          .map((one) => boundAt(one, one.name, name))
          .find((one) => one !== undefined)
      : undefined;
  }
  const declared = statementsOf(scope)
    .map((one) => blockDeclaration(one, name))
    .find(Boolean);
  return declared ?? (isSourceFile(scope) ? varDeclaration(scope, name) : undefined);
}

/**
 * The declaration an identifier written in a module resolves to by the scopes that enclose
 * it, nearest first, or undefined where none of them, the file included, declares it, as
 * for a global. A module read outside every program has no checker to ask.
 */
export function declarationOf(occurrence: Node & { readonly text: string }): Node | undefined {
  for (let scope = occurrence.parent; ; scope = scope.parent) {
    const found = scopeDeclaration(scope, occurrence.text);
    if (found !== undefined || isSourceFile(scope)) {
      return found;
    }
  }
}

/** The text a property name writes: a name, a literal, or a computed literal; undefined where it computes one. */
function keyOf(name: Node): string | undefined {
  if (
    isIdentifier(name) ||
    isStringLiteral(name) ||
    isNoSubstitutionTemplateLiteral(name) ||
    isNumericLiteral(name)
  ) {
    return name.text;
  }
  if (isComputedPropertyName(name)) {
    const key = unwrapped(name.expression);
    if (isStringLiteral(key) || isNoSubstitutionTemplateLiteral(key) || isNumericLiteral(key)) {
      return key.text;
    }
  }
  return undefined;
}

/** Whether one expression is the module's own directory: a free `__dirname`, or `import.meta.dirname`. */
function isOwnDirectory(node: Node): boolean {
  const held = unwrapped(node);
  if (isIdentifier(held)) {
    return held.text === "__dirname" && declarationOf(held) === undefined;
  }
  return (
    isPropertyAccessExpression(held) &&
    isMetaProperty(held.expression) &&
    held.expression.keywordToken === SyntaxKind.ImportKeyword &&
    held.name.text === "dirname"
  );
}

/** The literal segments a `resolve` or `join` call of the module's own directory writes, or undefined. */
function directorySegments(node: Node): readonly string[] | undefined {
  if (!isCallExpression(node)) {
    return undefined;
  }
  const callee = unwrapped(node.expression);
  const name = isPropertyAccessExpression(callee) ? callee.name : callee;
  const [first, ...rest] = node.arguments;
  if (
    !isIdentifier(name) ||
    (name.text !== "resolve" && name.text !== "join") ||
    first === undefined ||
    !isOwnDirectory(first)
  ) {
    return undefined;
  }
  const segments = rest.map((one) => {
    const part = unwrapped(one);
    return isStringLiteral(part) || isNoSubstitutionTemplateLiteral(part) ? part.text : undefined;
  });
  return segments.every((one) => one !== undefined) ? segments : undefined;
}

/** The value one expression writes out, parentheses, `as`, `satisfies` and `!` read through. */
export function writtenValue(node: Node): Value {
  const held = unwrapped(node);
  const at = held.getStart();
  const segments = directorySegments(held);
  if (segments !== undefined) {
    return { kind: "directory", segments, at };
  }
  if (isStringLiteral(held) || isNoSubstitutionTemplateLiteral(held)) {
    return { kind: "text", text: held.text, at };
  }
  if (held.kind === SyntaxKind.TrueKeyword || held.kind === SyntaxKind.FalseKeyword) {
    return { kind: "boolean", value: held.kind === SyntaxKind.TrueKeyword, at };
  }
  if (isArrayLiteralExpression(held)) {
    return {
      kind: "array",
      elements: held.elements.map((element) =>
        element.kind === SyntaxKind.SpreadElement
          ? { kind: "opaque", at: element.getStart() }
          : writtenValue(element),
      ),
      at,
    };
  }
  if (isObjectLiteralExpression(held)) {
    return {
      kind: "object",
      members: held.properties.map((member): Member => {
        const start = member.getStart();
        if (isSpreadAssignment(member)) {
          return { key: undefined, value: { kind: "opaque", at: start }, at: start };
        }
        const key = keyOf(member.name);
        return {
          key,
          value: isPropertyAssignment(member)
            ? writtenValue(member.initializer)
            : { kind: "opaque", at: start },
          at: start,
        };
      }),
      at,
    };
  }
  return { kind: "opaque", at };
}

/**
 * The initializer of a top-level `const`, `let` or `var` declaration of the file that
 * declares a name and that the file assigns nowhere else, so the initializer is the value
 * the name holds.
 */
function topLevelValue(declaration: Node | undefined, file: SourceFile): Node | undefined {
  if (
    declaration === undefined ||
    !isVariableDeclaration(declaration) ||
    !isIdentifier(declaration.name) ||
    declaration.initializer === undefined
  ) {
    return undefined;
  }
  const statement = declaration.parent.parent;
  if (!isVariableStatement(statement) || statement.parent !== file) {
    return undefined;
  }
  const constant = (declaration.parent.flags & NodeFlags.Const) !== 0;
  return constant || !assigned(file, declaration, declaration.name.text)
    ? declaration.initializer
    : undefined;
}

/** Whether the file writes a name that resolves to one declaration anywhere but its initializer. */
function assigned(file: SourceFile, declaration: Node, name: string): boolean {
  let found = false;
  const visit = (node: Node): void => {
    if (found) {
      return;
    }
    if (isIdentifier(node)) {
      found = node.text === name && isWriteTarget(node) && declarationOf(node) === declaration;
      return;
    }
    node.forEachChild(visit);
  };
  file.forEachChild(visit);
  return found;
}

/**
 * Whether one identifier is written: the target of an assignment, a destructuring
 * assignment's element included, the operand of `++` or `--`, or a `for`-`in` or
 * `for`-`of` target.
 */
function isWriteTarget(node: Node): boolean {
  let at = node;
  for (let parent = at.parent; ; at = parent, parent = parent.parent) {
    if (isParenthesizedExpression(parent) || isSpreadElement(parent)) {
      continue;
    }
    if (isShorthandPropertyAssignment(parent) && parent.name === at) {
      continue;
    }
    if (
      (isPropertyAssignment(parent) && parent.initializer === at) ||
      isArrayLiteralExpression(parent) ||
      isObjectLiteralExpression(parent)
    ) {
      continue;
    }
    break;
  }
  const parent = at.parent;
  if (isBinaryExpression(parent)) {
    return parent.left === at && isAssignmentOperator(parent.operatorToken.kind);
  }
  if (isPrefixUnaryExpression(parent) || isPostfixUnaryExpression(parent)) {
    return (
      at === node &&
      (parent.operator === SyntaxKind.PlusPlusToken ||
        parent.operator === SyntaxKind.MinusMinusToken)
    );
  }
  return (isForInStatement(parent) || isForOfStatement(parent)) && parent.initializer === at;
}

/**
 * The values one expression stands for: a name of a top-level binding read through to its
 * initializer, and, where `throughCalls`, a call read through to every argument it passes.
 * A `require` call's argument names a module, which is no value the call returns.
 */
function readThrough(
  node: Node,
  file: SourceFile,
  throughCalls: boolean,
  seen: ReadonlySet<Node> = new Set(),
): readonly Value[] {
  const held = unwrapped(node);
  if (isIdentifier(held)) {
    const value = topLevelValue(declarationOf(held), file);
    if (value !== undefined && !seen.has(value)) {
      return readThrough(value, file, throughCalls, new Set([...seen, value]));
    }
  } else if (throughCalls && isCallExpression(held) && !isRequireCall(held)) {
    return held.arguments.flatMap((argument) => readThrough(argument, file, throughCalls, seen));
  }
  return [writtenValue(held)];
}

/** The local names one module binds to another module's exports at its top level. */
interface Bindings {
  /** Each local name bound to one export, by the export's name; `default` for the module's value. */
  readonly named: ReadonlyMap<Node, string>;
  /** The declarations of each local name bound to the whole module. */
  readonly namespaces: ReadonlySet<Node>;
}

/** A written name's binding by the scopes that enclose it, {@link declarationOf} answering. */
const scopeBinding = lexicalBinding(declarationOf);

/** Whether one call is a `require()` call, read through `bindingOf`, the file's own scopes where no checker answers. */
function isRequireCall(call: CallExpression, bindingOf: BindingOf = scopeBinding): boolean {
  const callee = writtenName(call.expression);
  return callee !== undefined && callsPlatformBy("require", callee, bindingOf);
}

/** The literal one call's one argument writes, where it is a string literal or a template literal with no substitution. */
function loadedSpecifier(call: CallExpression): string | undefined {
  const [argument, ...rest] = call.arguments;
  return argument !== undefined &&
    rest.length === 0 &&
    (isStringLiteral(argument) || isNoSubstitutionTemplateLiteral(argument))
    ? argument.text
    : undefined;
}

/** Whether one expression is a `require()` call of a module `isModule` accepts, its specifier the one literal argument. */
function requires(
  node: Node,
  isModule: (specifier: string) => boolean,
  bindingOf: BindingOf = scopeBinding,
): boolean {
  const held = unwrapped(node);
  if (!isCallExpression(held)) {
    return false;
  }
  const specifier = loadedSpecifier(held);
  return specifier !== undefined && isModule(specifier) && isRequireCall(held, bindingOf);
}

/** What {@link boundExports} lists for a name bound to the module itself. */
export const NAMESPACE = "*";

/** Whether one import or re-export names a module `isModule` accepts. */
function fromModule(declaration: Node, isModule: (specifier: string) => boolean): boolean {
  return (
    isImportDeclaration(declaration) &&
    isStringLiteral(declaration.moduleSpecifier) &&
    isModule(declaration.moduleSpecifier.text)
  );
}

/**
 * What one declaration binds of a module `isModule` accepts: the export each name names,
 * `default` for the module's value, and {@link NAMESPACE} for the module itself. A default
 * import, an import assignment and a name a `require()` call initializes bind the value and
 * the module both, as interop reads them; an object binding pattern of such a call binds each
 * export it lists, and a member read of one binds that member.
 */
export function boundExports(
  declaration: Node,
  isModule: (specifier: string) => boolean,
  bindingOf: BindingOf = scopeBinding,
): readonly string[] {
  if (isImportClause(declaration)) {
    return declaration.name !== undefined && fromModule(declaration.parent, isModule)
      ? ["default", NAMESPACE]
      : [];
  }
  if (isNamespaceImport(declaration)) {
    return fromModule(declaration.parent.parent, isModule) ? [NAMESPACE] : [];
  }
  if (isImportSpecifier(declaration)) {
    return fromModule(declaration.parent.parent.parent, isModule)
      ? [(declaration.propertyName ?? declaration.name).text]
      : [];
  }
  if (isImportEqualsDeclaration(declaration)) {
    const reference = declaration.moduleReference;
    return isExternalModuleReference(reference) &&
      isStringLiteralLikeNode(reference.expression) &&
      isModule(reference.expression.text)
      ? ["default", NAMESPACE]
      : [];
  }
  if (isBindingElement(declaration) && isObjectBindingPattern(declaration.parent)) {
    const holder = declaration.parent.parent;
    const exported = declaration.propertyName ?? declaration.name;
    const key = exported === undefined ? undefined : keyOf(exported);
    return declaration.dotDotDotToken === undefined &&
      declaration.name !== undefined &&
      isIdentifier(declaration.name) &&
      key !== undefined &&
      isVariableDeclaration(holder) &&
      holder.initializer !== undefined &&
      requires(holder.initializer, isModule, bindingOf)
      ? [key]
      : [];
  }
  if (!isVariableDeclaration(declaration) || declaration.initializer === undefined) {
    return [];
  }
  const value = unwrapped(declaration.initializer);
  if (isIdentifier(declaration.name) && requires(value, isModule, bindingOf)) {
    return ["default", NAMESPACE];
  }
  return isIdentifier(declaration.name) &&
    isPropertyAccessExpression(value) &&
    requires(value.expression, isModule, bindingOf)
    ? [value.name.text]
    : [];
}

/**
 * The relative specifiers one module's imports and re-exports name, and those its
 * `require()` calls and `import()` calls name by a literal, in the order the file writes
 * them. A module read outside every program answers it so, with no checker to ask.
 */
export function relativeSpecifiers(file: SourceFile): readonly string[] {
  const known = specifiersOf.get(file);
  if (known !== undefined) {
    return known;
  }
  const found: string[] = [];
  const named = (specifier: string | undefined): void => {
    if (specifier?.startsWith("./") === true || specifier?.startsWith("../") === true) {
      found.push(specifier);
    }
  };
  const visit = (node: Node): void => {
    if (
      (isImportDeclaration(node) || isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      isStringLiteral(node.moduleSpecifier)
    ) {
      named(node.moduleSpecifier.text);
    } else if (
      isCallExpression(node) &&
      (node.expression.kind === SyntaxKind.ImportKeyword || isRequireCall(node))
    ) {
      named(loadedSpecifier(node));
    }
    node.forEachChild(visit);
  };
  file.forEachChild(visit);
  specifiersOf.set(file, found);
  return found;
}

/** What {@link relativeSpecifiers} found in each file, which every project of a run reads alike. */
const specifiersOf = new WeakMap<SourceFile, readonly string[]>();

/** The declarations one top-level statement makes that may bind another module. */
function bindingDeclarations(statement: Node): readonly Node[] {
  if (isImportDeclaration(statement)) {
    const clause = statement.importClause;
    const bindings = clause?.namedBindings;
    return [
      ...(clause === undefined ? [] : [clause]),
      ...(bindings === undefined
        ? []
        : isNamespaceImport(bindings)
          ? [bindings]
          : bindings.elements),
    ];
  }
  if (isImportEqualsDeclaration(statement)) {
    return [statement];
  }
  if (!isVariableStatement(statement)) {
    return [];
  }
  return statement.declarationList.declarations.flatMap((declaration) =>
    isObjectBindingPattern(declaration.name)
      ? [declaration, ...declaration.name.elements]
      : [declaration],
  );
}

/** The top-level bindings one file makes of a module, as {@link boundExports} reads each. */
function bindingsOf(file: SourceFile, module: string): Bindings {
  const named = new Map<Node, string>();
  const namespaces = new Set<Node>();
  const isModule = (specifier: string): boolean => specifier === module;
  for (const declaration of file.statements.flatMap(bindingDeclarations)) {
    for (const exported of boundExports(declaration, isModule)) {
      if (exported === NAMESPACE) {
        namespaces.add(declaration);
      } else {
        named.set(declaration, exported);
      }
    }
  }
  return { named, namespaces };
}

/** One call of a module's export the file makes, and the export it calls. */
interface ExportCall {
  readonly call: CallExpression;
  readonly export: string;
}

/**
 * Every call one file makes of one module's exports: through a name an import or a
 * `require` binding gives it, a namespace's member, a member of a `require` of the
 * module, or that `require`'s value called itself, each where no scope enclosing the
 * call declares the name otherwise.
 */
function callsOf(file: SourceFile, module: string): readonly ExportCall[] {
  const { named, namespaces } = bindingsOf(file, module);
  const found: ExportCall[] = [];
  const visit = (node: Node): void => {
    if (isCallExpression(node)) {
      const callee = unwrapped(node.expression);
      if (isIdentifier(callee)) {
        const declaration = declarationOf(callee);
        const exported = declaration === undefined ? undefined : named.get(declaration);
        if (exported !== undefined) {
          found.push({ call: node, export: exported });
        }
      } else if (requires(callee, (specifier) => specifier === module)) {
        found.push({ call: node, export: "default" });
      } else if (isPropertyAccessExpression(callee)) {
        const holder = unwrapped(callee.expression);
        const declaration = isIdentifier(holder) ? declarationOf(holder) : undefined;
        if (
          (declaration !== undefined && namespaces.has(declaration)) ||
          requires(holder, (specifier) => specifier === module)
        ) {
          found.push({ call: node, export: callee.name.text });
        }
      }
    }
    node.forEachChild(visit);
  };
  file.forEachChild(visit);
  return found;
}

/** What one module writes out, read without running it. */
export interface StaticModule {
  /** Every value the module exports as its default, in each form, read through names and calls. */
  readonly defaultExport: readonly Value[];
  /** The first argument of each call of one module's export, read through a top-level name. */
  options(module: string, exported: string): readonly Value[];
  /** Every call of one module's exports the module makes. */
  calls(module: string): readonly ExportCall[];
  /** The first argument one call passes, read through a top-level name. */
  argument(call: CallExpression): readonly Value[];
}

/** One parsed module, or a JSON document parsed as one, read as {@link StaticModule}. */
export function staticModule(file: SourceFile): StaticModule {
  const argument = (call: CallExpression): readonly Value[] => {
    const [first] = call.arguments;
    return first === undefined ? [] : readThrough(first, file, false);
  };
  return {
    defaultExport: defaultExportOf(file),
    options: (module, exported) =>
      callsOf(file, module).flatMap((one) => (one.export === exported ? argument(one.call) : [])),
    calls: (module) => callsOf(file, module),
    argument,
  };
}

/** A YAML document's value read as {@link StaticModule}: its default export, and no call. */
export function documentModule(value: unknown): StaticModule {
  return {
    defaultExport: [documentValue(value)],
    options: () => [],
    calls: () => [],
    argument: () => [],
  };
}

/** The value a CommonJS module leaves, its later member writes and any hidden member on it. */
function moduleValueOf(written: ModuleValue, file: SourceFile): readonly Value[] {
  const members: Member[] = written.members.map((member) => {
    const at = member.node.getStart();
    return {
      key: member.key,
      value: member.value === undefined ? { kind: "opaque", at } : writtenValue(member.value),
      at,
    };
  });
  if (written.open) {
    members.push({ key: undefined, value: { kind: "opaque", at: undefined }, at: undefined });
  }
  if (written.whole === undefined) {
    return members.length === 0 ? [] : [{ kind: "object", members, at: members[0]?.at }];
  }
  return readThrough(written.whole, file, true).map((value) =>
    value.kind === "object" ? { ...value, members: [...value.members, ...members] } : value,
  );
}

/**
 * The values a module's default export forms write: `export default`, `export =`, a
 * `default` specifier, a JSON document, and, in a file Node runs as CommonJS, the module
 * value as Node leaves it. A default function or class writes no value to read.
 */
function defaultExportOf(file: SourceFile): readonly Value[] {
  if (file.fileName.endsWith(".json")) {
    return file.statements.flatMap((statement) =>
      isExpressionStatement(statement) ? [writtenValue(statement.expression)] : [],
    );
  }
  const commonJS = commonJSModuleValue(file, declarationOf);
  if (commonJS !== undefined) {
    return moduleValueOf(commonJS, file);
  }
  const found: Value[] = [];
  for (const statement of file.statements) {
    if (isExportAssignment(statement)) {
      found.push(...readThrough(statement.expression, file, true));
    } else if (
      (isFunctionDeclaration(statement) || isClassDeclaration(statement)) &&
      statement.modifiers?.some((one) => one.kind === SyntaxKind.DefaultKeyword) === true
    ) {
      found.push({ kind: "opaque", at: statement.getStart() });
    } else if (
      isExportDeclaration(statement) &&
      statement.moduleSpecifier === undefined &&
      statement.exportClause !== undefined &&
      isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        if (element.name.text === "default") {
          found.push(...readThrough(element.propertyName ?? element.name, file, true));
        }
      }
    }
  }
  return found;
}

/**
 * The values one object writes for a key after its last spread or computed key, the last
 * written last, or undefined where none follows one, which may write the key unseen. A
 * value that is no object writes none.
 */
export function membersNamed(value: Value, key: string): readonly Value[] | undefined {
  if (value.kind !== "object") {
    return [];
  }
  const hidden = value.members.findLastIndex((member) => member.key === undefined);
  const after = value.members.slice(hidden + 1).filter((member) => member.key === key);
  return hidden >= 0 && after.length === 0 ? undefined : after.map((member) => member.value);
}

/**
 * The texts one value writes: itself where it is text, or, where `elements`, each element
 * of an array of texts. Undefined for any other value.
 */
export function textsOf(value: Value, elements: boolean): readonly string[] | undefined {
  if (value.kind === "text") {
    return [value.text];
  }
  if (!elements || value.kind !== "array") {
    return undefined;
  }
  const texts = value.elements.map((element) =>
    element.kind === "text" ? element.text : undefined,
  );
  return texts.every((text) => text !== undefined) ? texts : undefined;
}

/**
 * The values at one path of keys below each value, whatever else the path holds: a key
 * reads an object's members of that name, and `*` every element of an array and every
 * member of an object.
 */
export function valuesAt(values: readonly Value[], path: readonly string[]): readonly Value[] {
  const [key, ...rest] = path;
  if (key === undefined) {
    return values;
  }
  const next = values.flatMap((value): readonly Value[] => {
    if (key === "*" && value.kind === "array") {
      return value.elements;
    }
    if (value.kind !== "object") {
      return [];
    }
    return value.members
      .filter((member) => key === "*" || member.key === key)
      .map((member) => member.value);
  });
  return valuesAt(next, rest);
}
