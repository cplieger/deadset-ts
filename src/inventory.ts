import {
  isClassDeclaration,
  isComputedPropertyName,
  isConstructorDeclaration,
  isEnumMember,
  isFunctionDeclaration,
  isGetAccessorDeclaration,
  isIdentifier,
  isInterfaceDeclaration,
  isMethodDeclaration,
  isMethodSignatureDeclaration,
  isParameterDeclaration,
  isPrivateIdentifier,
  isPropertyDeclaration,
  isPropertySignatureDeclaration,
  isSetAccessorDeclaration,
  isTypeAliasDeclaration,
  ModifierFlags,
  SyntaxKind,
  type Node,
  type SourceFile,
} from "@typescript/native/ast";
import { byPosition, positionKey, renderPosition, startLine, type Position } from "./position.ts";
import { renderRef, spell, type Component, type Module } from "./ref.ts";
import { signatureOf } from "./signatures.ts";

/**
 * The symbol inventory of one project: every declaration the target's own files hold, at
 * its own position, with the container it belongs to and the reference that survives an
 * edit above it. A container's members are the union of its symbol table, which holds a
 * member of a merged declaration and a private name, and its syntactic member list, which
 * holds a computed key the binder resolves later; a member both sources name appears once.
 */

/** What one declaration is, from the vocabulary the Contract's finding schema closes. */
export type SymbolKind =
  | "file"
  | "function"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "namespace"
  | "variable"
  | "export-alias"
  | "method"
  | "class-member"
  | "interface-method"
  | "type-member"
  | "enum-member"
  | "type-parameter";

/** The reader's word for each kind of declaration, as a finding names it. */
export const WORDS: Readonly<Record<SymbolKind, string>> = {
  file: "file",
  function: "function",
  class: "class",
  interface: "interface",
  type: "type alias",
  enum: "enum",
  namespace: "namespace",
  variable: "variable",
  "export-alias": "re-export",
  method: "method",
  "class-member": "class member",
  "interface-method": "interface method",
  "type-member": "type member",
  "enum-member": "enum member",
  "type-parameter": "type parameter",
};

/**
 * How a member may be named from outside its container. A `private` member is still
 * reachable at run time by its name; a private name does not exist outside the class body.
 */
export type Visibility = "public" | "protected" | "private" | "private-name";

/** One declaration of the target. */
export interface InventorySymbol {
  /** The identifier of the declaration's own position, which the graph keys on. */
  readonly id: string;
  /** The stable symbol reference, which survives an edit above the declaration. */
  readonly ref: string;
  /**
   * The display name a text line renders: the chain from the container inward, each
   * component in the spelling a reference gives it, and the declared local name of a
   * default export, whose reference carries its export name instead.
   */
  readonly name: string;
  readonly kind: SymbolKind;
  readonly position: Position;
  /** The line the declaration ends on, so its size in source lines is readable. */
  readonly endLine: number;
  /** The container's id: the file for a module-level declaration, empty for a file. */
  readonly parent: string;
  /**
   * Whether the export table of the module or namespace that holds the declaration names
   * it: false for every member of a class, an interface, a type or an enum and for every
   * type parameter, whose reach is its visibility and its container's.
   */
  readonly exported: boolean;
  readonly visibility: Visibility;
  /** Whether the declaration is a static member of a class. */
  readonly static: boolean;
}

/** Where a directive written above a declaration binds it. */
interface Placement {
  /**
   * The lines a directive written above binds the declaration on: the line of the first
   * token of each node that declares it, of a variable's statement and of each parameter
   * of the function it declares. Ascending.
   */
  readonly startLines: readonly number[];
  /** The id of the declaration a directive for a part kind binds on those lines. */
  readonly holder: string;
  /**
   * The lines a directive binds only the declaration's parts on: a class's constructors
   * and their parameters that declare no member. Ascending.
   */
  readonly partLines: readonly number[];
}

/** What one project's inventory cost at the client boundary. */
export interface InventoryCost {
  /** Batched symbol lookups. One pass over every module and container of the project. */
  readonly batches: number;
  /** Export-table reads: one per module and one per namespace. */
  readonly exportTables: number;
  /**
   * Member-table reads: one per interface and enum, and two per class, because a class
   * keeps its instance members and its static members in two tables.
   */
  readonly memberTables: number;
}

/** One project's declarations, in position order, and what reading them cost. */
export interface Inventory {
  readonly symbols: readonly InventorySymbol[];
  /**
   * Each declaring node's {@link nodeKey} mapped to the identifier of the declaration
   * enumerated there, so a reading that starts from a node resolves the declaration
   * without rendering its position again. A getter and a setter of one name are one
   * declaration and two nodes, so both nodes name it.
   */
  readonly declarations: ReadonlyMap<string, string>;
  readonly cost: InventoryCost;
  /**
   * The declarations whose export or member table is unknown, in position order: the
   * checker did not answer a table of theirs or of a container holding them, or they are
   * entries of a CommonJS export table, whose readers no reference source models.
   */
  readonly unanswered: readonly string[];
  /**
   * Every declaration other than a file by each name a use may spell it with: its
   * component, its declared name where that differs, and a type parameter's own name.
   */
  readonly byName: ReadonlyMap<string, readonly string[]>;
  /** Each `declare module` declaration whose name is a string literal, by id, to that name. */
  readonly modules: ReadonlyMap<string, string>;
  /**
   * The ids of the ambient declarations: those of a declaration file, and those a `declare`
   * modifier carries or a declaration carrying one holds.
   */
  readonly ambient: ReadonlySet<string>;
  /**
   * Each enum member's dependents, by id: the later members of its declaration with no
   * initializer, up to the first one with an initializer, whose values its deletion moves.
   */
  readonly dependents: ReadonlyMap<string, readonly string[]>;
  /** Each declaration but a file, by id, to where a directive binds it. */
  readonly placement: ReadonlyMap<string, Placement>;
  /**
   * The ids of the CommonJS files that write their exports in a form their table does not
   * model, so an import of one may read anything it exports.
   */
  // deadset:ignore DS1301 -- only tests read open tables
  readonly openTables: ReadonlySet<string>;
}

/**
 * One node's identity inside one program, which is how two readings of that program name
 * one declaration: the binder's table and the tree meet here, and so does the reference
 * pass, which starts from a resolved symbol's declaration.
 */
export function nodeKey(file: SourceFile, node: Node): string {
  return `${file.fileName}:${String(node.pos)}:${String(node.end)}:${String(node.kind)}`;
}

/**
 * Whether one node is a parameter property: a constructor parameter carrying an
 * accessibility, `readonly` or `override` modifier, which also declares an instance member
 * of the class, with the parameter's node as the member's declaration.
 */
export function isParameterProperty(node: Node): boolean {
  return (
    isParameterDeclaration(node) &&
    isConstructorDeclaration(node.parent) &&
    (modifiersOf(node) & ModifierFlags.ParameterPropertyModifier) !== 0
  );
}

/**
 * The fragment component one declaration's name spells in a reference, as the inventory
 * spells it, or undefined for a name the grammar does not represent.
 */
export function declaredComponent(node: Node): string | undefined {
  const component = componentOf(nameNodeOf(node));
  return component === undefined ? undefined : spell(component);
}

/** A declaration under construction, before its reference is rendered. */
export interface Building {
  readonly file: SourceFile;
  readonly node: Node;
  readonly module: Module;
  readonly position: Position;
  endLine: number;
  readonly kind: SymbolKind;
  /** The chain of the container, without this declaration's own component. */
  readonly parentChain: readonly Component[];
  /** This declaration's own component: a default export's is its export name. */
  readonly component: Component;
  /** The declared name, where it is not what the component spells. */
  readonly localName: string | undefined;
  readonly parent: Building | undefined;
  readonly visibility: Visibility;
  readonly static: boolean;
  exported: boolean;
  /** The type parameter this declaration is, where it is one. */
  readonly typeParameter: string | undefined;
  /** The declaration that holds this one's parts: a parameter property's class, else itself. */
  readonly holder: Building | undefined;
  readonly startLines: Set<number>;
  readonly partLines: Set<number>;
}

/** A container whose members are read from a symbol table, from the tree, or both. */
export interface Container {
  readonly owner: Building;
  /** The declaration that writes the container, which owns the members written inside it. */
  readonly declaration: Node;
  /** The container's name node, which a batch resolves to its symbol; none reads no table. */
  readonly nameNode: Node | undefined;
  readonly members: readonly Node[];
  /**
   * `class-member` for a class, whose static members are a second table, and `enum-member`
   * for an enum, which keeps its members in its export table.
   */
  readonly memberKind: SymbolKind;
}

/** A module or namespace whose export table says which of its declarations it exports. */
interface ExportScope {
  readonly owner: Building;
  readonly nameNode: Node;
}

/** The name a declaration is declared under: its component, and its declared name beside it. */
interface Named {
  readonly component: Component;
  readonly localName: string | undefined;
}

/** One mechanism that finds the declarations a file writes, run per file in list order. */
export interface DeclarationSource {
  declare(file: SourceFile, owner: Building, into: Builder): void;
}

/**
 * Collects one project's declarations, from every {@link DeclarationSource} and from the
 * binder's tables, and renders them. A member is kept once per container, by its
 * component and its side of a class, whichever mechanism names it first.
 */
export class Builder {
  readonly #targetRoot: string;
  readonly #records: Building[] = [];
  readonly #byNode = new Map<string, Building>();
  readonly #exportScopes: ExportScope[] = [];
  readonly #containers: Container[] = [];
  readonly #modules: (readonly [Building, string])[] = [];
  readonly #unansweredOwners = new Set<Building>();
  readonly #openTables = new Set<Building>();

  constructor(targetRoot: string) {
    this.#targetRoot = targetRoot;
  }

  get exportScopes(): readonly ExportScope[] {
    return this.#exportScopes;
  }

  get containers(): readonly Container[] {
    return this.#containers;
  }

  /** One file's own record, which is also the export scope of its module. */
  file(file: SourceFile, module: Module, path: string): Building {
    const record = this.#keep(file, file, 0, {
      module,
      kind: "file",
      parentChain: [],
      // A file's reference names its module, so no component of it is ever spelled; the
      // path is what a text line renders for it.
      component: { text: path, computed: false },
      localName: path,
      parent: undefined,
    });
    this.#exportScopes.push({ owner: record, nameNode: file });
    return record;
  }

  /** One declaration written under `owner`, placed at its name, and its type parameters. */
  declare(
    node: Node,
    owner: Building,
    kind: SymbolKind,
    name: Node | undefined,
    named: Named,
  ): Building {
    const record = this.#keep(owner.file, node, name?.getStart() ?? unnamedStart(node), {
      module: owner.module,
      kind,
      parentChain: owner.kind === "file" ? [] : chainOf(owner),
      ...named,
      parent: owner,
      visibility: visibilityOf(node, name),
      static: (modifiersOf(node) & ModifierFlags.Static) !== 0,
    });
    this.#declareTypeParameters(node, record);
    return record;
  }

  /** A container of members; a class's constructors are where its parts are bound. */
  container(container: Container): void {
    this.#containers.push(container);
    if (container.memberKind !== "class-member") {
      return;
    }
    for (const member of container.members.filter(isConstructorDeclaration)) {
      for (const at of [member, ...member.parameters.filter((one) => !isParameterProperty(one))]) {
        container.owner.partLines.add(startLine(container.owner.file, at.pos));
      }
    }
  }

  /** A namespace whose export table says which of its declarations it exports. */
  exportScope(owner: Building, nameNode: Node): void {
    this.#exportScopes.push({ owner, nameNode });
  }

  /** A `declare module` declaration named by a string literal. */
  module(record: Building, name: string): void {
    this.#modules.push([record, name]);
  }

  /** The declaration enumerated at one node, where one is. */
  recordAt(node: Node): Building | undefined {
    return this.#byNode.get(nodeKey(node.getSourceFile(), node));
  }

  /** Records that a table of `owner` is unknown, which leaves everything under it unknown. */
  unanswered(owner: Building): void {
    this.#unansweredOwners.add(owner);
  }

  /** Records that one file writes its exports in a form its table does not model. */
  openTable(file: Building): void {
    this.#openTables.add(file);
  }

  /**
   * One member of a container. A getter and a setter of one name are one symbol and one
   * reference, so the second declaration widens the first record rather than making a
   * second, and both nodes name that record.
   */
  member(container: Container, node: Node, seen: Map<string, Building>, areStatic: boolean): void {
    const kind = memberKindOf(container, node);
    if (kind === undefined) {
      return;
    }
    const name = nameNodeOf(node);
    const component = componentOf(name);
    if (component === undefined) {
      return;
    }
    const file = node.getSourceFile();
    const key = memberKey(component, areStatic);
    const held = seen.get(key);
    const endLine = this.#endOf(file, node);
    if (held !== undefined) {
      held.endLine = Math.max(held.endLine, endLine);
      this.#byNode.set(nodeKey(file, node), held);
      placeAt(held, node);
      return;
    }
    const record = this.#keep(file, node, (name ?? node).getStart(), {
      module: container.owner.module,
      kind,
      parentChain: chainOf(container.owner),
      component,
      parent: container.owner,
      visibility: visibilityOf(node, name),
      static: areStatic,
      holder: isParameterProperty(node) ? container.owner : undefined,
    });
    seen.set(key, record);
    this.#declareTypeParameters(node, record);
  }

  /** The inventory of everything collected. */
  build(cost: InventoryCost): Inventory {
    const byId = new Map(this.#records.map((record) => [positionKey(record.position), record]));
    const symbols = this.#records.map(render).sort((a, b) => byPosition(a.position, b.position));
    return {
      symbols,
      declarations: new Map(
        [...this.#byNode].map(([key, record]) => [key, positionKey(record.position)] as const),
      ),
      cost,
      unanswered: symbols
        .filter((symbol) => underUnanswered(byId.get(symbol.id), this.#unansweredOwners))
        .map((symbol) => symbol.id),
      byName: namesOf(this.#records),
      modules: new Map(this.#modules.map(([record, name]) => [positionKey(record.position), name])),
      ambient: new Set(
        this.#records
          .filter((record) => isAmbient(record.file, record.node))
          .map((record) => positionKey(record.position)),
      ),
      dependents: dependentsOf(this.#containers, (node) => this.recordAt(node)),
      placement: placementOf(this.#records),
      openTables: new Set([...this.#openTables].map((file) => positionKey(file.position))),
    };
  }

  #keep(
    file: SourceFile,
    node: Node,
    at: number,
    fields: Pick<Building, "module" | "kind" | "parentChain" | "component" | "parent"> &
      Partial<Pick<Building, "localName" | "visibility" | "static" | "typeParameter" | "holder">>,
  ): Building {
    const kept: Building = {
      file,
      node,
      position: renderPosition(file, this.#targetRoot, at),
      endLine: this.#endOf(file, node),
      localName: undefined,
      visibility: "public",
      static: false,
      exported: false,
      typeParameter: undefined,
      holder: undefined,
      ...fields,
      startLines: new Set(),
      partLines: new Set(),
    };
    this.#records.push(kept);
    this.#byNode.set(nodeKey(kept.file, kept.node), kept);
    if (kept.kind !== "file") {
      placeAt(kept, kept.node);
    }
    return kept;
  }

  #declareTypeParameters(node: Node, owner: Building): void {
    for (const parameter of typeParametersOf(node)) {
      const name = nameNodeOf(parameter);
      if (name === undefined) {
        continue;
      }
      this.#keep(owner.file, parameter, name.getStart(), {
        module: owner.module,
        kind: "type-parameter",
        parentChain: owner.parentChain,
        component: owner.component,
        parent: owner,
        static: owner.static,
        typeParameter: name.getText(),
      });
    }
  }

  #endOf(file: SourceFile, node: Node): number {
    return renderPosition(file, this.#targetRoot, Math.max(node.end - 1, 0)).line;
  }
}

/** The lines one declaring node binds its declaration on. */
function placeAt(record: Building, node: Node): void {
  const file = record.file;
  record.startLines.add(startLine(file, node.pos));
  for (const parameter of signatureOf(node)?.parameters ?? []) {
    record.startLines.add(startLine(file, parameter.pos));
  }
  const list = node.parent as Node | undefined;
  if (
    node.kind === SyntaxKind.VariableDeclaration &&
    list?.kind === SyntaxKind.VariableDeclarationList &&
    list.parent.kind === SyntaxKind.VariableStatement
  ) {
    record.startLines.add(startLine(file, list.parent.pos));
  }
}

/** The modifier flags one node carries, and zero for a node that carries none. */
export function modifiersOf(node: Node): number {
  return (node as { readonly modifierFlags?: number }).modifierFlags ?? 0;
}

/** The name node of one declaration, for the kinds that carry one. */
export function nameNodeOf(node: Node): Node | undefined {
  return (node as { readonly name?: Node }).name;
}

/**
 * The reference component one declaration name node spells, and undefined for a name the
 * grammar does not represent: a binding pattern, and a computed key whose source text
 * carries a closing bracket.
 */
export function componentOf(name: Node | undefined): Component | undefined {
  if (name === undefined) {
    return undefined;
  }
  if (isComputedPropertyName(name)) {
    const text = name.expression.getText();
    return text.includes("]") ? undefined : { text, computed: true };
  }
  if (isIdentifier(name) || isPrivateIdentifier(name)) {
    return { text: name.getText(), computed: false };
  }
  const text = name.getText();
  if (text.startsWith('"') || text.startsWith("'") || text.startsWith("`")) {
    // A string key's own text carries its quotes; the reference carries the value.
    return { text: text.slice(1, -1), computed: false };
  }
  return /^[0-9]/u.test(text) ? { text, computed: false } : undefined;
}

/**
 * The component one declaration's reference carries, and its declared name where the two
 * differ. A declaration its module exports as the default is named `default`, its export
 * name, which a module has at most one of and an anonymous declaration has too.
 */
export function exportedAs(
  node: Node,
  name: Node | undefined,
): { readonly component: Component | undefined; readonly localName: string | undefined } {
  const declared = componentOf(name);
  if ((modifiersOf(node) & ModifierFlags.Default) === 0) {
    return { component: declared, localName: undefined };
  }
  return { component: { text: "default", computed: false }, localName: declared?.text };
}

/** One member's identity inside its container: its component, and its side of a class. */
export function memberKey(component: Component, isStatic: boolean): string {
  return `${component.computed ? "[" : ""}${component.text}${isStatic ? ":static" : ""}`;
}

/** The visibility one member declaration's modifiers and name give it. */
function visibilityOf(node: Node, name: Node | undefined): Visibility {
  if (name !== undefined && isPrivateIdentifier(name)) {
    return "private-name";
  }
  const flags = modifiersOf(node);
  if ((flags & ModifierFlags.Private) !== 0) {
    return "private";
  }
  if ((flags & ModifierFlags.Protected) !== 0) {
    return "protected";
  }
  return "public";
}

/** Whether a declaration is ambient: in a declaration file, or under a `declare` modifier. */
export function isAmbient(file: SourceFile, node: Node): boolean {
  if (file.isDeclarationFile) {
    return true;
  }
  for (let at: Node | undefined = node; at !== undefined; at = at.parent as Node | undefined) {
    if ((modifiersOf(at) & ModifierFlags.Ambient) !== 0) {
      return true;
    }
  }
  return false;
}

/** The type parameters one node declares, and none for a node that declares none. */
function typeParametersOf(node: Node): readonly Node[] {
  if (
    isFunctionDeclaration(node) ||
    isMethodDeclaration(node) ||
    isMethodSignatureDeclaration(node) ||
    isClassDeclaration(node) ||
    isInterfaceDeclaration(node) ||
    isTypeAliasDeclaration(node)
  ) {
    return node.typeParameters ?? [];
  }
  return [];
}

/** `export default`, up to the keyword that stands where an unnamed default export's name would. */
const DEFAULT_EXPORT = /^export\s+(?=default\b)/u;

/**
 * Where an unnamed declaration is placed: at `default` when it is the default export, so it
 * never shares the file's own position, else at its first token.
 */
function unnamedStart(node: Node): number {
  const start = node.getStart();
  const prefix = DEFAULT_EXPORT.exec(node.getText());
  return prefix === null ? start : start + prefix[0].length;
}

/** The kind one member of a container takes, and undefined for a node that is no member. */
function memberKindOf(container: Container, node: Node): SymbolKind | undefined {
  if (container.memberKind === "class-member") {
    if (
      isPropertyDeclaration(node) ||
      isGetAccessorDeclaration(node) ||
      isSetAccessorDeclaration(node) ||
      isParameterProperty(node)
    ) {
      return "class-member";
    }
    return isMethodDeclaration(node) ? "method" : undefined;
  }
  if (container.memberKind === "enum-member") {
    return isEnumMember(node) ? "enum-member" : undefined;
  }
  if (isMethodSignatureDeclaration(node)) {
    return container.memberKind === "interface-method" ? "interface-method" : "type-member";
  }
  if (
    isPropertySignatureDeclaration(node) ||
    isGetAccessorDeclaration(node) ||
    isSetAccessorDeclaration(node)
  ) {
    return "type-member";
  }
  return undefined;
}

/**
 * Each enum member's dependents: the later members of its declaration with no initializer,
 * up to the first one with an initializer.
 */
function dependentsOf(
  containers: readonly Container[],
  recordAt: (node: Node) => Building | undefined,
): ReadonlyMap<string, readonly string[]> {
  const dependents = new Map<string, readonly string[]>();
  for (const container of containers.filter((one) => one.memberKind === "enum-member")) {
    const ids = container.members.map((member) => {
      const record = recordAt(member);
      return record === undefined ? undefined : positionKey(record.position);
    });
    container.members.forEach((_member, index) => {
      const after: string[] = [];
      for (let next = index + 1; next < container.members.length; next += 1) {
        const member = container.members[next];
        if (member === undefined || !isEnumMember(member) || member.initializer !== undefined) {
          break;
        }
        const id = ids[next];
        if (id !== undefined) {
          after.push(id);
        }
      }
      const id = ids[index];
      if (id !== undefined && after.length > 0) {
        dependents.set(id, after);
      }
    });
  }
  return dependents;
}

/** Each declaration but a file to where a directive binds it. */
function placementOf(records: readonly Building[]): ReadonlyMap<string, Placement> {
  const ascending = (lines: ReadonlySet<number>): readonly number[] =>
    [...lines].sort((a, b) => a - b);
  return new Map(
    records
      .filter((record) => record.kind !== "file")
      .map((record) => [
        positionKey(record.position),
        {
          startLines: ascending(record.startLines),
          holder: positionKey((record.holder ?? record).position),
          partLines: ascending(record.partLines),
        },
      ]),
  );
}

/** Whether one declaration is, or is declared under, a scope or container left unanswered. */
function underUnanswered(record: Building | undefined, owners: ReadonlySet<Building>): boolean {
  for (let at = record; at !== undefined; at = at.parent) {
    if (owners.has(at)) {
      return true;
    }
  }
  return false;
}

/** Every declaration but a file, by each name a use may spell it with. */
function namesOf(records: readonly Building[]): ReadonlyMap<string, readonly string[]> {
  const byName = new Map<string, string[]>();
  for (const record of records) {
    if (record.kind === "file") {
      continue;
    }
    const id = positionKey(record.position);
    const names =
      record.typeParameter === undefined
        ? [record.component.text, record.localName]
        : [record.typeParameter];
    for (const name of new Set(names)) {
      if (name === undefined) {
        continue;
      }
      const ids = byName.get(name);
      if (ids === undefined) {
        byName.set(name, [id]);
      } else if (!ids.includes(id)) {
        ids.push(id);
      }
    }
  }
  return byName;
}

/** The chain of components that names one declaration, read from the module inward. */
function chainOf(record: Building): readonly Component[] {
  return [...record.parentChain, record.component];
}

/**
 * One declaration as the inventory reports it. The display name is the chain in the
 * spelling a reference gives it, except where the declaration carries a name of its own
 * the reference does not: a file, whose reference names its module, and a default export.
 */
function render(record: Building): InventorySymbol {
  const chain = chainOf(record);
  const spelled = chain.map(spell).join(".");
  return {
    id: positionKey(record.position),
    ref: refOf(record, chain),
    name:
      record.localName ??
      (record.typeParameter === undefined ? spelled : `${spelled}<${record.typeParameter}>`),
    kind: record.kind,
    position: record.position,
    endLine: record.endLine,
    parent: record.parent === undefined ? "" : positionKey(record.parent.position),
    exported: record.exported,
    visibility: record.visibility,
    static: record.static,
  };
}

function refOf(record: Building, chain: readonly Component[]): string {
  if (record.kind === "file") {
    return renderRef(record.module, { of: "module" });
  }
  if (record.kind === "export-alias") {
    const block = record.parentChain.at(-1);
    return renderRef(record.module, {
      of: "alias",
      name: record.component.text,
      ...(block === undefined ? {} : { block: block.text }),
    });
  }
  return renderRef(record.module, {
    of: "declaration",
    chain,
    static: record.static,
    ...(record.typeParameter === undefined ? {} : { typeParameter: record.typeParameter }),
  });
}
