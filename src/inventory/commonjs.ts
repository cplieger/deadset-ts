import {
  isArrayBindingPattern,
  isArrowFunction,
  isAssignmentOperator,
  isAwaitExpression,
  isBinaryExpression,
  isBindingElement,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isClassStaticBlockDeclaration,
  isComputedPropertyName,
  isDeleteExpression,
  isElementAccessExpression,
  isEqualityOperator,
  isExpressionStatement,
  isForOfStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isFunctionLikeDeclaration,
  isGetAccessorDeclaration,
  isIdentifier,
  isIfStatement,
  isMetaProperty,
  isMethodDeclaration,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSourceFile,
  isSpreadAssignment,
  isStringLiteral,
  isTypeOfExpression,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVariableStatement,
  ModifierFlags,
  NodeFlags,
  SyntaxKind,
  type BinaryExpression,
  type ClassExpression,
  type Identifier,
  type Node,
  type ObjectLiteralElementLike,
  type PropertyAccessExpression,
  type SourceFile,
} from "@typescript/native/ast";
import {
  componentOf,
  modifiersOf,
  type Builder,
  type Building,
  type DeclarationSource,
  type SymbolKind,
} from "../inventory.ts";
import { callsPlatformBy, lexicalBinding, writtenName, type BindingOf } from "../platform-calls.ts";
import type { Component } from "../ref.ts";
import { spellsNoBinding } from "../spelled-names.ts";
import { unwrapped } from "../unwrap.ts";

/**
 * The export table of a CommonJS file: the module value `module.exports` is assigned and
 * the properties written on it, read from the top-level unconditional statements in order,
 * as Node runs them (https://nodejs.org/api/modules.html#moduleexports). Each entry is
 * keyed by the node that writes it, the checker's declaration of the export where it binds
 * one. Any other write of the exports opens the table: its entries are kept and the file is
 * listed open. `declarationOf` reads a `require()` call through the file's own scopes.
 */
export function commonJS(
  typeIsModule: (path: string) => boolean,
  resolved: Resolved,
  declarationOf: (occurrence: Identifier) => Node | undefined,
): DeclarationSource {
  return {
    declare(file: SourceFile, owner: Building, into: Builder): void {
      if (!isCommonJS(file, owner.position.path, typeIsModule)) {
        return;
      }
      const bound = boundOccurrences(file, resolved);
      const free = (node: Node): boolean => !bound.has(node);
      const table = readTable(
        file,
        free,
        topLevelDeclarations(file),
        lexicalBinding(declarationOf),
      );
      const open = table.open || opens(file, free, table.modelled);
      for (const entry of table.entries.values()) {
        const record = into.declare(entry.node, owner, entry.kind, entry.name, {
          component: entry.component,
          localName: entry.localName,
        });
        record.exported = true;
        const target = entry.target === undefined ? undefined : into.recordAt(entry.target);
        if (target !== undefined) {
          target.exported = true;
        }
        if (entry.members !== undefined) {
          into.container({
            owner: record,
            declaration: entry.members,
            nameNode: entry.members.name,
            members: entry.members.members,
            memberKind: "class-member",
          });
        }
        // No reference source reads a `require` of the table yet, so whether an entry is
        // used is unknown, and it is held live and reported by nothing.
        into.unanswered(record);
      }
      if (open) {
        into.openTable(owner);
      }
    },
  };
}

/**
 * The declarations the compiler resolves each occurrence to, in the order given, as nodes
 * of the program; an occurrence it leaves unanswered has none.
 */
export type Resolved = (occurrences: readonly Identifier[]) => readonly (readonly Node[])[];

/** The bindings whose free occurrence is the module system's own. */
const WATCHED = ["module", "exports", "require"];

/**
 * Whether Node runs one file as CommonJS: a `.cjs` file, or a `.js` or `.jsx` file outside a
 * `type: module` package that holds no ECMAScript module syntax
 * (https://nodejs.org/api/packages.html#determining-module-system).
 */
function isCommonJS(
  file: SourceFile,
  path: string,
  typeIsModule: (path: string) => boolean,
): boolean {
  if (file.fileName.endsWith(".cjs")) {
    return true;
  }
  return /\.jsx?$/u.test(file.fileName) && !typeIsModule(path) && !writesModuleSyntax(file);
}

/** Whether one file holds an import or export declaration, `import.meta` or a top-level `await`. */
function writesModuleSyntax(file: SourceFile): boolean {
  const declares = file.statements.some(
    (statement) =>
      (statement.flags & NodeFlags.Reparsed) === 0 &&
      (statement.kind === SyntaxKind.ImportDeclaration ||
        statement.kind === SyntaxKind.ExportDeclaration ||
        statement.kind === SyntaxKind.ExportAssignment ||
        (modifiersOf(statement) & ModifierFlags.Export) !== 0),
  );
  let found = declares;
  const visit = (node: Node, inFunction: boolean): void => {
    if (found) {
      return;
    }
    if (
      (isMetaProperty(node) && node.keywordToken === SyntaxKind.ImportKeyword) ||
      (!inFunction &&
        (isAwaitExpression(node) || (isForOfStatement(node) && node.awaitModifier !== undefined)))
    ) {
      found = true;
      return;
    }
    const inner = inFunction || isFunctionLikeDeclaration(node);
    node.forEachChild((child) => {
      visit(child, inner);
    });
  };
  file.forEachChild((child) => {
    visit(child, false);
  });
  return found;
}

/**
 * The occurrences of a watched name that Node binds to a declaration of the file. The
 * compiler resolves each one, and one it leaves unanswered, or resolves to no such
 * declaration, is the module system's own.
 */
function boundOccurrences(file: SourceFile, resolved: Resolved): ReadonlySet<Node> {
  const occurrences: Identifier[] = [];
  const visit = (node: Node): void => {
    if (isIdentifier(node)) {
      if (WATCHED.includes(node.text) && !spellsNoBinding(node)) {
        occurrences.push(node);
      }
      return;
    }
    node.forEachChild(visit);
  };
  file.forEachChild(visit);
  const declarations = resolved(occurrences);
  const bound = new Set<Node>();
  occurrences.forEach((occurrence, index) => {
    if (declarations[index]?.some((declaration) => bindsOwn(declaration, file)) === true) {
      bound.add(occurrence);
    }
  });
  return bound;
}

/**
 * Whether one declaration the compiler resolves a watched name to is a binding Node gives
 * it in the file. Where the file is the var scope, a `var`, destructured or not, re-declares
 * a parameter of Node's wrapper, which keeps the module system's value until assigned, and
 * an `if`-clause function binds only in its clause, as the parameter stops it hoisting; the
 * compiler gives each its own symbol, so both read as free (Annex B.3.2, B.3.3,
 * https://tc39.es/ecma262/#sec-functiondeclarationinstantiation).
 */
function bindsOwn(declaration: Node, file: SourceFile): boolean {
  if (isSourceFile(declaration) || declaration.getSourceFile() !== file) {
    return false;
  }
  let named = declaration;
  while (isBindingElement(named)) {
    named = named.parent.parent;
  }
  const redeclares =
    (isVariableDeclaration(named) &&
      isVariableDeclarationList(named.parent) &&
      (named.parent.flags & NodeFlags.BlockScoped) === 0) ||
    (isFunctionDeclaration(declaration) && isIfStatement(declaration.parent));
  return !redeclares || !inFileVarScope(declaration);
}

/** Whether no function or class static block encloses one node below its file. */
function inFileVarScope(node: Node): boolean {
  for (let at = node.parent; !isSourceFile(at); at = at.parent) {
    if (isFunctionLikeDeclaration(at) || isClassStaticBlockDeclaration(at)) {
      return false;
    }
  }
  return true;
}

/** The node that declares each name a file's top-level function, class or variable binds. */
function topLevelDeclarations(file: SourceFile): ReadonlyMap<string, Node> {
  const found = new Map<string, Node>();
  const bind = (name: Node, node: Node): void => {
    if (isIdentifier(name)) {
      found.set(name.text, node);
    } else if (isObjectBindingPattern(name) || isArrayBindingPattern(name)) {
      for (const element of name.elements) {
        if (isBindingElement(element) && element.name !== undefined) {
          bind(element.name, element);
        }
      }
    }
  };
  for (const statement of file.statements) {
    if ((isFunctionDeclaration(statement) || isClassDeclaration(statement)) && statement.name) {
      found.set(statement.name.text, statement);
    } else if (isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        bind(declaration.name, declaration);
      }
    }
  }
  return found;
}

/** One entry of the table: what writes it, where it is placed, and what it declares. */
interface Entry {
  readonly node: Node;
  readonly name: Node;
  readonly component: Component;
  readonly localName: string | undefined;
  readonly kind: SymbolKind;
  /** The value written under the key, undefined for an accessor. */
  readonly value: Node | undefined;
  /** The declaration of the file the module value names, which the export then exports. */
  readonly target?: Node;
  /** The class whose members the entry holds. */
  readonly members?: ClassExpression;
}

interface Table {
  readonly entries: ReadonlyMap<string, Entry>;
  /** Whether a write the scan read opens the table. */
  readonly open: boolean;
  /** Every write the scan read, which the opening walk then passes over. */
  readonly modelled: ReadonlySet<Node>;
  /** The value the last assignment of `module.exports` writes, undefined where none does. */
  readonly whole: Node | undefined;
  /** Whether a member write opens the table, apart from a module value the table cannot read. */
  readonly membersOpen: boolean;
}

const DEFAULT: Component = { text: "default", computed: false };

/** The table one file's top-level unconditional statements write, in order. */
function readTable(
  file: SourceFile,
  isFree: (node: Node) => boolean,
  declarations: ReadonlyMap<string, Node>,
  bindingOf: BindingOf,
): Table {
  const entries = new Map<string, Entry>();
  const modelled = new Set<Node>();
  // Written inside the closures below, which the compiler's narrowing does not follow.
  let open = false as boolean;
  let aliasing = true;
  let whole: Node | undefined;
  let wholeOpen = false;
  const free = (node: Node, name: string): boolean =>
    isIdentifier(node) && node.text === name && isFree(node);
  const isModuleExports = (node: Node): node is PropertyAccessExpression =>
    isPropertyAccessExpression(node) &&
    free(node.expression, "module") &&
    node.name.text === "exports";
  const isRequire = (node: Node): boolean => {
    if (!isCallExpression(node) || node.arguments.length !== 1) {
      return false;
    }
    const [argument] = node.arguments;
    const callee = writtenName(node.expression);
    return (
      argument !== undefined &&
      isLiteralText(argument) &&
      callee !== undefined &&
      callsPlatformBy("require", callee, bindingOf)
    );
  };

  /** What a value written under one key declares. */
  const entryOf = (
    component: Component,
    node: Node,
    name: Node,
    value: Node | undefined,
  ): Entry => {
    const held = value === undefined ? undefined : unwrapped(value);
    const base = { node, name, component, localName: undefined, value };
    if (held === undefined) {
      return { ...base, kind: "variable" };
    }
    if ((isIdentifier(held) && declarations.has(held.text)) || isRequire(held)) {
      return { ...base, kind: "export-alias" };
    }
    if (isFunctionExpression(held) || isArrowFunction(held) || isMethodDeclaration(held)) {
      return { ...base, kind: "function" };
    }
    if (isClassExpression(held)) {
      return { ...base, kind: "class", members: held };
    }
    return { ...base, kind: "variable" };
  };

  const property = (node: Node, name: Node, value: Node | undefined): void => {
    const component = isComputedPropertyName(name) ? undefined : componentOf(name);
    if (component === undefined) {
      open = true;
      return;
    }
    if (component.text === "__esModule") {
      return;
    }
    if (component.text === "default" && entries.get("default")?.component === DEFAULT) {
      // `#default` would name the module value and this property both.
      open = true;
      return;
    }
    entries.delete(component.text);
    entries.set(component.text, entryOf(component, node, name, value));
  };

  const literalProperty = (element: ObjectLiteralElementLike): void => {
    if (isShorthandPropertyAssignment(element)) {
      property(element, element.name, element.name);
    } else if (isPropertyAssignment(element)) {
      property(element, element.name, element.initializer);
    } else if (isMethodDeclaration(element)) {
      property(element, element.name, element);
    } else if (isGetAccessorDeclaration(element) || isSetAccessorDeclaration(element)) {
      property(element, element.name, undefined);
    } else if (!isSpreadAssignment(element) || !isRequire(unwrapped(element.expression))) {
      open = true;
    }
  };

  /** The module value one assignment writes, placed at the `exports` name it assigns. */
  const moduleValue = (node: BinaryExpression, name: Node): void => {
    entries.clear();
    whole = node.right;
    const value = unwrapped(node.right);
    if (isRequire(value)) {
      return;
    }
    if (isObjectLiteralExpression(value)) {
      value.properties.forEach(literalProperty);
      return;
    }
    const base = { node, name, component: DEFAULT, value: node.right };
    const target = isIdentifier(value) ? declarations.get(value.text) : undefined;
    if (target !== undefined) {
      entries.set("default", { ...base, localName: undefined, kind: "export-alias", target });
    } else if (isFunctionExpression(value)) {
      entries.set("default", { ...base, localName: value.name?.text, kind: "function" });
    } else if (isArrowFunction(value)) {
      entries.set("default", { ...base, localName: undefined, kind: "function" });
    } else if (isClassExpression(value)) {
      entries.set("default", {
        ...base,
        localName: value.name?.text,
        kind: "class",
        members: value,
      });
    } else {
      wholeOpen = true;
    }
  };

  /** Whether one expression is the exports object a top-level write may name here. */
  const exportsObject = (node: Node): "module" | "exports" | undefined =>
    isModuleExports(node) ? "module" : free(node, "exports") ? "exports" : undefined;

  for (const statement of file.statements) {
    if (!isExpressionStatement(statement)) {
      continue;
    }
    const expression = unwrapped(statement.expression);
    if (
      isBinaryExpression(expression) &&
      expression.operatorToken.kind === SyntaxKind.EqualsToken
    ) {
      const left = expression.left;
      if (free(left, "exports")) {
        modelled.add(expression);
        const inner = unwrapped(expression.right);
        aliasing = false;
        if (
          isBinaryExpression(inner) &&
          inner.operatorToken.kind === SyntaxKind.EqualsToken &&
          isModuleExports(inner.left)
        ) {
          aliasing = true;
          modelled.add(inner);
          moduleValue(inner, inner.left.name);
        }
      } else if (isModuleExports(left)) {
        modelled.add(expression);
        const inner = unwrapped(expression.right);
        const chained =
          isBinaryExpression(inner) &&
          inner.operatorToken.kind === SyntaxKind.EqualsToken &&
          free(inner.left, "exports")
            ? inner
            : undefined;
        if (chained !== undefined) {
          modelled.add(chained);
        }
        moduleValue(chained ?? expression, left.name);
        aliasing = chained !== undefined;
      } else if (isPropertyAccessExpression(left) || isElementAccessExpression(left)) {
        const object = exportsObject(left.expression);
        const key = isPropertyAccessExpression(left) ? left.name : left.argumentExpression;
        if (object === "exports" && !aliasing) {
          // Node discards a write through an `exports` that no longer aliases the module.
          modelled.add(expression);
        } else if (
          object !== undefined &&
          (isPropertyAccessExpression(left) || isLiteralKey(key))
        ) {
          modelled.add(expression);
          property(expression, key, expression.right);
        }
      }
      continue;
    }
    if (isCallExpression(expression) && isDefineProperty(expression.expression)) {
      const [object, key, descriptor] = expression.arguments;
      const written = object === undefined ? undefined : exportsObject(object);
      if (written === "exports" && !aliasing) {
        modelled.add(expression);
        continue;
      }
      const value = descriptor === undefined ? undefined : describedValue(descriptor);
      if (written !== undefined && key !== undefined && isLiteralText(key) && value !== undefined) {
        modelled.add(expression);
        property(expression, key, value.value);
      }
    }
  }
  return { entries, open: open || wholeOpen, modelled, whole, membersOpen: open };
}

/** One member a CommonJS file's module value holds, as {@link commonJSModuleValue} reads it. */
interface WrittenMember {
  readonly key: string;
  /** The value written, undefined for an accessor. */
  readonly value: Node | undefined;
  /** The node that writes the member. */
  readonly node: Node;
}

/** The module value a CommonJS file leaves once Node has run its top level. */
export interface ModuleValue {
  /** The value the last assignment of `module.exports` writes, where that is no object literal. */
  readonly whole: Node | undefined;
  /** The members written on the module value, an object literal assigned to `module.exports` among them. */
  readonly members: readonly WrittenMember[];
  /** Whether a write the table does not model may set any member. */
  readonly open: boolean;
}

/**
 * The module value one file leaves where Node runs it as CommonJS, read by the one table
 * the inventory's export table reads, or undefined where the file writes module syntax.
 * `declarationOf` names the declaration each name resolves to, undefined for none, as a
 * lexical reading of a file outside every program answers it.
 */
export function commonJSModuleValue(
  file: SourceFile,
  declarationOf: (occurrence: Identifier) => Node | undefined,
): ModuleValue | undefined {
  if (writesModuleSyntax(file)) {
    return undefined;
  }
  const free = (node: Node): boolean => {
    const declaration = isIdentifier(node) ? declarationOf(node) : undefined;
    return declaration === undefined || !bindsOwn(declaration, file);
  };
  const table = readTable(file, free, topLevelDeclarations(file), lexicalBinding(declarationOf));
  const held = table.whole === undefined ? undefined : unwrapped(table.whole);
  const members = [...table.entries.values()].flatMap((entry) =>
    entry.component === DEFAULT && held !== undefined && !isObjectLiteralExpression(held)
      ? []
      : [{ key: entry.component.text, value: entry.value, node: entry.node }],
  );
  return {
    whole: held === undefined || isObjectLiteralExpression(held) ? undefined : table.whole,
    members,
    open: table.membersOpen || opens(file, free, table.modelled),
  };
}

/** Whether one node is `Object.defineProperty`. */
function isDefineProperty(node: Node): boolean {
  return (
    isPropertyAccessExpression(node) &&
    isIdentifier(node.expression) &&
    node.expression.text === "Object" &&
    node.name.text === "defineProperty"
  );
}

/** The value a property descriptor literal gives, where it writes a `value` or a `get`. */
function describedValue(descriptor: Node): { readonly value: Node | undefined } | undefined {
  if (!isObjectLiteralExpression(descriptor)) {
    return undefined;
  }
  let found: { readonly value: Node | undefined } | undefined;
  for (const element of descriptor.properties) {
    const key = isSpreadAssignment(element) ? undefined : componentOf(element.name)?.text;
    if (key === "value") {
      return {
        value: isPropertyAssignment(element)
          ? element.initializer
          : isMethodDeclaration(element)
            ? element
            : undefined,
      };
    }
    if (key === "get") {
      found = { value: undefined };
    }
  }
  return found;
}

/** Whether one node is literal text: a string, or a template with no substitution. */
function isLiteralText(node: Node): boolean {
  return isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node);
}

/** Whether one element access key is literal: text or a number. */
function isLiteralKey(node: Node): boolean {
  return isLiteralText(node) || isNumericLiteral(node);
}

/**
 * Whether one file writes its exports anywhere the table does not model: through `module`,
 * `module.exports` or the free `exports` written, assigned, passed or stored outside the
 * statements the scan read, or through a top-level `this`.
 */
function opens(
  file: SourceFile,
  isFree: (node: Node) => boolean,
  modelled: ReadonlySet<Node>,
): boolean {
  let open = false;
  const visit = (node: Node, thisIsExports: boolean): void => {
    if (open) {
      return;
    }
    if (isIdentifier(node)) {
      open = opensAt(node, isFree, modelled);
      return;
    }
    if (node.kind === SyntaxKind.ThisKeyword) {
      open = thisIsExports && writes(node, modelled);
      return;
    }
    const fn = isFunctionLikeDeclaration(node);
    const innerThis =
      thisIsExports &&
      !(fn && !isArrowFunction(node)) &&
      !isClassDeclaration(node) &&
      !isClassExpression(node);
    node.forEachChild((child) => {
      visit(child, innerThis);
    });
  };
  file.forEachChild((child) => {
    visit(child, true);
  });
  return open;
}

/** Whether one free occurrence of `module` or `exports` opens the table. */
function opensAt(
  node: Identifier,
  isFree: (node: Node) => boolean,
  modelled: ReadonlySet<Node>,
): boolean {
  const name = node.text;
  if ((name !== "module" && name !== "exports") || !isFree(node) || spellsNoBinding(node)) {
    return false;
  }
  if (name === "exports") {
    return writes(node, modelled);
  }
  const parent = node.parent;
  if (isPropertyAccessExpression(parent) && parent.expression === node) {
    return parent.name.text === "exports" && writes(parent, modelled);
  }
  if (isElementAccessExpression(parent) && parent.expression === node) {
    return writes(parent, modelled);
  }
  return !readOnly(node);
}

/**
 * Whether the exports object one expression names is written, or escapes where it may be
 * written, other than by a write the scan read: assigned, a property of it assigned,
 * incremented or deleted, or the value handed anywhere but a `typeof` or a comparison.
 */
function writes(object: Node, modelled: ReadonlySet<Node>): boolean {
  const parent = object.parent;
  if (assigns(parent, object)) {
    return !modelled.has(parent);
  }
  if (
    (isPropertyAccessExpression(parent) || isElementAccessExpression(parent)) &&
    parent.expression === object
  ) {
    const holder = parent.parent;
    const written =
      assigns(holder, parent) ||
      isDeleteExpression(holder) ||
      ((isPrefixUnaryExpression(holder) || isPostfixUnaryExpression(holder)) &&
        (holder.operator === SyntaxKind.PlusPlusToken ||
          holder.operator === SyntaxKind.MinusMinusToken));
    return written && !modelled.has(holder);
  }
  if (isCallExpression(parent) && modelled.has(parent)) {
    return false;
  }
  return !readOnly(object);
}

/** Whether `holder` assigns to `target`, by any assignment operator. */
function assigns(holder: Node, target: Node): holder is BinaryExpression {
  return (
    isBinaryExpression(holder) &&
    holder.left === target &&
    isAssignmentOperator(holder.operatorToken.kind)
  );
}

/** Whether one value is only read: the operand of a `typeof` or of an equality comparison. */
function readOnly(node: Node): boolean {
  const parent = node.parent;
  return (
    isTypeOfExpression(parent) ||
    (isBinaryExpression(parent) && isEqualityOperator(parent.operatorToken.kind))
  );
}
