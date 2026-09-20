import {
  isClassDeclaration,
  isComputedPropertyName,
  isEnumDeclaration,
  isEnumMember,
  isExportAssignment,
  isExportDeclaration,
  isFunctionDeclaration,
  isGetAccessorDeclaration,
  isIdentifier,
  isInterfaceDeclaration,
  isIntersectionTypeNode,
  isMethodDeclaration,
  isMethodSignatureDeclaration,
  isModuleBlock,
  isModuleDeclaration,
  isNamespaceExport,
  isPrivateIdentifier,
  isPropertyDeclaration,
  isPropertySignatureDeclaration,
  isSetAccessorDeclaration,
  isTypeAliasDeclaration,
  isTypeLiteralNode,
  isUnionTypeNode,
  isVariableStatement,
  ModifierFlags,
  type Node,
  type SourceFile,
} from "@typescript/native/unstable/ast";
import type { Symbol as TSSymbol } from "@typescript/native/unstable/sync";
import type { Host } from "./host.ts";
import { dirnamePath, joinPath, relativePath } from "./paths.ts";
import { byPosition, positionKey, renderPosition, type Position } from "./position.ts";
import { computedComponent, nameComponent, renderRef, type Component, type Module } from "./ref.ts";
import type { Handle, ProjectView } from "./session.ts";

/**
 * The symbol inventory of one project: every declaration the target's own files
 * hold, at its own position, with the container it belongs to and the reference
 * that survives an edit above it.
 *
 * Two mechanisms produce it and neither is redundant. A container's symbol table is
 * the binder's own answer, so it holds a member of a declaration that merges with
 * another and it holds a member whatever its visibility, a private name included;
 * a container's syntactic member list holds a member whose key is computed, which
 * the binder resolves later and does not put in the table. The set is the union,
 * keyed by the member's own reference component, so a member both sources name
 * appears once.
 */

/**
 * What one declaration is, from the vocabulary the Contract's finding schema
 * closes. A Go rendering of the same vocabulary names other members of it; these
 * are the ones a TypeScript declaration takes.
 */
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

/**
 * How a member may be named from outside the container that declares it.
 *
 * The last two are two facts rather than one. A `private` modifier is a
 * compile-time constraint only, so the member is still reachable at run time by its
 * name through a string index, a decorator, a container or a serializer; a private
 * name is not reachable by any of them, because the name does not exist outside the
 * class body. An exemption class that finds its evidence in a name therefore
 * applies to the first and never to the second, and the Contract's exemption
 * vocabulary records that per class.
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
   * Whether the export table of the module or namespace that holds the declaration
   * names it. It is a fact about that one table, so it is false for every member of
   * a class, an interface, a type or an enum and for every type parameter, whose
   * reach outside its container is {@link InventorySymbol.visibility} and the state
   * of the container the parent names.
   */
  readonly exported: boolean;
  readonly visibility: Visibility;
  /** Whether the declaration is a static member of a class. */
  readonly static: boolean;
}

/** What one project's inventory cost at the client boundary. */
export interface InventoryCost {
  /** Batched symbol lookups. One pass over every module and container of the project. */
  readonly batches: number;
  /** Export-table reads: one per module and one per namespace. */
  readonly exportTables: number;
  /**
   * Member-table reads: one per interface and enum, and two per class, because a
   * class keeps its instance members and its static members in two tables. Never
   * one per member.
   */
  readonly memberTables: number;
}

/** One project's declarations, in position order, and what reading them cost. */
export interface Inventory {
  /** The compiler configuration the project was opened from. */
  readonly configFile: string;
  readonly symbols: readonly InventorySymbol[];
  /**
   * Each declaring node's {@link nodeKey} mapped to the identifier of the declaration
   * enumerated there. A reading that starts from a node of the same program, rather
   * than from a position, resolves the declaration through this map instead of
   * rendering the position a second time, so the rule that decides a declaration's
   * identifier has one owner.
   *
   * A getter and a setter of one name are one declaration and two nodes, so both nodes
   * name it.
   */
  readonly declarations: ReadonlyMap<string, string>;
  readonly cost: InventoryCost;
  /**
   * The module specifiers of the bare star re-exports the project's files carry, in
   * the order they were read. A bare star re-export declares nothing here: the names
   * it carries forward are the declarations of the module it names, so it is a
   * reference to that module and not a declaration of this one.
   */
  readonly starReExports: readonly string[];
  /**
   * The number of member declarations that were left out because the file declaring
   * them is not one of the target's own files. Such a declaration belongs to another
   * program, so the target's inventory does not name it, and the count is reported so
   * that the omission is a number rather than a silence.
   */
  readonly outsideOwnFiles: number;
}

/** A declaration under construction, before its reference is rendered. */
interface Building {
  readonly file: SourceFile;
  readonly node: Node;
  readonly module: Module;
  readonly position: Position;
  endLine: number;
  readonly kind: SymbolKind;
  /** The chain of the container, without this declaration's own component. */
  readonly parentChain: readonly Component[];
  /**
   * This declaration's own component. A default export's is its export name, which
   * is where the component and the declared name part company.
   */
  readonly component: Component;
  /** The declared name, where it is not what the component spells. */
  readonly localName: string | undefined;
  readonly parent: Building | undefined;
  readonly visibility: Visibility;
  readonly static: boolean;
  exported: boolean;
  /** The type parameter this declaration is, where it is one. */
  readonly typeParameter: string | undefined;
}

/** A container whose members are read from a symbol table, from the tree, or both. */
interface Container {
  readonly owner: Building;
  /** The container's name node, which is what a batch resolves to its symbol. */
  readonly nameNode: Node | undefined;
  readonly members: readonly Node[];
  readonly memberKind: SymbolKind;
  /** Whether the container is a class, whose static members are a second table. */
  readonly isClass: boolean;
  /** Whether the container keeps its members in the export table, as an enum does. */
  readonly membersAreExports: boolean;
}

/** A module or namespace whose export table says which of its declarations it exports. */
interface ExportScope {
  readonly owner: Building;
  readonly nameNode: Node;
}

const MANIFEST = "package.json";

/** One manifest that names a package, and the directory below the root that holds it. */
interface Named {
  readonly name: string;
  readonly at: string;
}

/**
 * Resolves each file's package scope: the name of the nearest manifest at or above
 * its directory up to the target root, and the file's path below that manifest.
 * Where no manifest up to the root carries a name, the package is a single dot and
 * the path is read from the root, which cannot collide, because a package name never
 * starts with a dot.
 *
 * One directory is read at most once, because a package holds many files and a
 * manifest read is a filesystem call.
 */
function packages(host: Host, root: string): (path: string) => Module {
  const named = new Map<string, Named | undefined>();

  const manifestName = (dir: string): string | undefined => {
    let text: string;
    try {
      text = host.readFile(joinPath(root, dir, MANIFEST));
    } catch {
      return undefined;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      // A manifest this program cannot read names no package, which is the same
      // answer as an absent one: the file is then scoped by the target root.
      return undefined;
    }
    if (typeof value !== "object" || value === null) {
      return undefined;
    }
    const name = (value as Record<string, unknown>)["name"];
    return typeof name === "string" && name !== "" ? name : undefined;
  };

  const nearest = (dir: string): Named | undefined => {
    if (named.has(dir)) {
      return named.get(dir);
    }
    const name = manifestName(dir);
    const found =
      name !== undefined ? { name, at: dir } : dir === "" ? undefined : nearest(parentOf(dir));
    named.set(dir, found);
    return found;
  };

  return (path) => {
    const found = nearest(parentOf(path));
    if (found === undefined) {
      return { package: ".", path };
    }
    return { package: found.name, path: found.at === "" ? path : path.slice(found.at.length + 1) };
  };
}

/** The directory one path below the root sits in, and the root itself as the empty path. */
function parentOf(path: string): string {
  const dir = dirnamePath(path);
  return dir === "." ? "" : dir;
}

/** The modifier flags one node carries, and zero for a node that carries none. */
function modifiersOf(node: Node): number {
  return (node as { readonly modifierFlags?: number }).modifierFlags ?? 0;
}

/** The type parameters one node declares, and none for a node that declares none. */
function typeParametersOf(node: Node): readonly Node[] {
  if (
    isFunctionDeclaration(node) ||
    isMethodDeclaration(node) ||
    isMethodSignatureDeclaration(node)
  ) {
    return node.typeParameters ?? [];
  }
  return [];
}

/**
 * The reference component one declaration name node spells, and undefined for a
 * name the grammar does not represent: a binding pattern, and a computed key whose
 * source text carries a closing bracket.
 */
function componentOf(name: Node | undefined): Component | undefined {
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
  if (isStringOrNumericName(name)) {
    // A string or numeric key's own text carries its quotes and its numeric
    // spelling; the reference carries the value, which the component then quotes.
    return { text: literalTextOf(name), computed: false };
  }
  return undefined;
}

function isStringOrNumericName(name: Node): boolean {
  const text = name.getText();
  return (
    text.startsWith('"') || text.startsWith("'") || text.startsWith("`") || /^[0-9]/u.test(text)
  );
}

/** One member's identity inside its container: its component, and its side of a class. */
function memberKey(component: Component, isStatic: boolean): string {
  return `${component.computed ? "[" : ""}${component.text}${isStatic ? ":static" : ""}`;
}

/**
 * The members one type alias declares: the members of the object type it writes, and
 * of every object type that is a direct constituent of a union or an intersection it
 * writes. A constituent naming another type declares nothing here, because that
 * declaration carries its own members.
 *
 * A name two constituents both declare is left out of all of them. The alias stands
 * for such a member, because the two declarations are one member of the type and
 * neither of them is the one a reference to it would name.
 */
function aliasMembers(type: Node): readonly Node[] {
  const literals = isTypeLiteralNode(type)
    ? [type]
    : isUnionTypeNode(type) || isIntersectionTypeNode(type)
      ? type.types.filter(isTypeLiteralNode)
      : [];
  if (literals.length < 2) {
    return literals[0]?.members ?? [];
  }

  const declaring = new Map<string, number>();
  for (const literal of literals) {
    for (const key of new Set(literal.members.map(keyOf))) {
      if (key !== undefined) {
        declaring.set(key, (declaring.get(key) ?? 0) + 1);
      }
    }
  }
  return literals.flatMap((literal) =>
    literal.members.filter((member) => {
      const key = keyOf(member);
      return key !== undefined && declaring.get(key) === 1;
    }),
  );
}

/** One type member's identity, and undefined for a member the grammar cannot name. */
function keyOf(member: Node): string | undefined {
  const component = componentOf(nameNodeOf(member));
  return component === undefined ? undefined : memberKey(component, false);
}

/** The value one string or numeric key denotes, which is what the reference names. */
function literalTextOf(name: Node): string {
  const text = name.getText();
  if (text.startsWith('"') || text.startsWith("'") || text.startsWith("`")) {
    return text.slice(1, -1);
  }
  return text;
}

/**
 * The component one declaration's reference carries, and its declared name where the
 * two differ.
 *
 * A declaration its module exports as the default is named `default`, because that is
 * its export name and a module has at most one, so the spelling is unambiguous and it
 * holds for an anonymous declaration too. Its declared name is a fact about the source
 * rather than about the export, so it travels beside the component as the display name.
 */
function exportedAs(
  node: Node,
  name: Node | undefined,
): { readonly component: Component | undefined; readonly localName: string | undefined } {
  const declared = componentOf(name);
  if ((modifiersOf(node) & ModifierFlags.Default) === 0) {
    return { component: declared, localName: undefined };
  }
  return { component: { text: "default", computed: false }, localName: declared?.text };
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

/** The name node of one declaration, for the kinds that carry one. */
function nameNodeOf(node: Node): Node | undefined {
  return (node as { readonly name?: Node }).name;
}

/**
 * One node's identity inside one program, which is how two readings of that program
 * name one declaration.
 *
 * The two mechanisms behind the member set resolve a member separately and meet here;
 * so does the reference pass, which starts from a resolved symbol's declaration and
 * needs the declaration this enumeration made for it.
 */
export function nodeKey(file: SourceFile, node: Node): string {
  return `${file.fileName}:${String(node.pos)}:${String(node.end)}`;
}

/** The kind a class element takes: a method, or a property or accessor. */
function classMemberKind(node: Node): SymbolKind {
  return isMethodDeclaration(node) ? "method" : "class-member";
}

/** The kind a type element takes: a method of an interface, or any other member. */
function typeMemberKind(node: Node, inInterface: boolean): SymbolKind {
  return inInterface && isMethodSignatureDeclaration(node) ? "interface-method" : "type-member";
}

/**
 * Every declaration one project's own files hold.
 *
 * `targetRoot` is the absolute path every position is rendered against; a file the
 * program holds that is not below it ends the enumeration rather than being passed
 * over. `host` is the filesystem the manifests that name each file's package are
 * read through, and nothing else is read from it.
 *
 * The order is by rendered position, so two enumerations of one project return the
 * same list whatever order the program reported its files in.
 */
export function inventory<Brand>(
  project: ProjectView<Brand>,
  host: Host,
  targetRoot: string,
): Inventory {
  const files = project.ownSourceFiles();
  const ownFiles = new Set(files.map((file) => file.fileName));
  const moduleOf = packages(host, targetRoot);

  const building: Building[] = [];
  const byNode = new Map<string, Building>();
  const exportScopes: ExportScope[] = [];
  const containers: Container[] = [];
  const starReExports: string[] = [];
  let outsideOwnFiles = 0;

  const keep = (record: Building): Building => {
    building.push(record);
    byNode.set(nodeKey(record.file, record.node), record);
    return record;
  };

  for (const file of files) {
    const path = relativePath(targetRoot, file.fileName);
    if (path === undefined) {
      // renderPosition states the refusal, with the root it was rendered against.
      renderPosition(file, targetRoot, 0);
      continue;
    }
    const module = moduleOf(path);
    const fileRecord = keep({
      file,
      node: file,
      module,
      position: renderPosition(file, targetRoot, 0),
      endLine: renderPosition(file, targetRoot, Math.max(file.end - 1, 0)).line,
      kind: "file",
      parentChain: [],
      // A file's reference names its module, so no component of it is ever spelled;
      // the path is what a text line renders for it.
      component: { text: path, computed: false },
      localName: path,
      parent: undefined,
      visibility: "public",
      static: false,
      exported: false,
      typeParameter: undefined,
    });
    exportScopes.push({ owner: fileRecord, nameNode: file });
    walkStatements(file.statements, fileRecord);
  }

  /** One declaration of a module, a namespace or a container body. */
  function walkStatements(statements: readonly Node[], owner: Building): void {
    for (const statement of statements) {
      walkStatement(statement, owner);
    }
  }

  function declare(
    node: Node,
    owner: Building,
    kind: SymbolKind,
    name: Node | undefined,
    named: { readonly component: Component; readonly localName: string | undefined },
  ): Building {
    const at = name ?? node;
    const record = keep({
      file: owner.file,
      node,
      module: owner.module,
      position: renderPosition(owner.file, targetRoot, at.getStart()),
      endLine: renderPosition(owner.file, targetRoot, Math.max(node.end - 1, 0)).line,
      kind,
      parentChain: owner.kind === "file" ? [] : chainOf(owner),
      component: named.component,
      localName: named.localName,
      parent: owner,
      visibility: visibilityOf(node, name),
      static: (modifiersOf(node) & ModifierFlags.Static) !== 0,
      exported: false,
      typeParameter: undefined,
    });
    declareTypeParameters(node, record);
    return record;
  }

  function declareTypeParameters(node: Node, owner: Building): void {
    for (const parameter of typeParametersOf(node)) {
      const name = nameNodeOf(parameter);
      if (name === undefined) {
        continue;
      }
      keep({
        file: owner.file,
        node: parameter,
        module: owner.module,
        position: renderPosition(owner.file, targetRoot, name.getStart()),
        endLine: renderPosition(owner.file, targetRoot, Math.max(parameter.end - 1, 0)).line,
        kind: "type-parameter",
        parentChain: owner.parentChain,
        component: owner.component,
        localName: undefined,
        parent: owner,
        visibility: "public",
        static: owner.static,
        exported: false,
        typeParameter: name.getText(),
      });
    }
  }

  function walkStatement(node: Node, owner: Building): void {
    if (isFunctionDeclaration(node)) {
      const named = exportedAs(node, node.name);
      if (named.component !== undefined) {
        declare(node, owner, "function", node.name, { ...named, component: named.component });
      }
      return;
    }
    if (isClassDeclaration(node)) {
      const named = exportedAs(node, node.name);
      if (named.component === undefined) {
        return;
      }
      const record = declare(node, owner, "class", node.name, {
        ...named,
        component: named.component,
      });
      containers.push({
        owner: record,
        nameNode: node.name,
        members: node.members,
        memberKind: "class-member",
        isClass: true,
        membersAreExports: false,
      });
      return;
    }
    if (isInterfaceDeclaration(node)) {
      const named = exportedAs(node, node.name);
      if (named.component === undefined) {
        return;
      }
      const record = declare(node, owner, "interface", node.name, {
        ...named,
        component: named.component,
      });
      containers.push({
        owner: record,
        nameNode: node.name,
        members: node.members,
        memberKind: "interface-method",
        isClass: false,
        membersAreExports: false,
      });
      return;
    }
    if (isTypeAliasDeclaration(node)) {
      const named = exportedAs(node, node.name);
      if (named.component === undefined) {
        return;
      }
      const record = declare(node, owner, "type", node.name, {
        ...named,
        component: named.component,
      });
      // A type alias keeps no member table of its own: the members belong to the
      // object types its declaration writes, so the declaration is what carries them.
      const members = aliasMembers(node.type);
      if (members.length > 0) {
        containers.push({
          owner: record,
          nameNode: undefined,
          members,
          memberKind: "type-member",
          isClass: false,
          membersAreExports: false,
        });
      }
      return;
    }
    if (isEnumDeclaration(node)) {
      const named = exportedAs(node, node.name);
      if (named.component === undefined) {
        return;
      }
      const record = declare(node, owner, "enum", node.name, {
        ...named,
        component: named.component,
      });
      containers.push({
        owner: record,
        nameNode: node.name,
        members: node.members,
        memberKind: "enum-member",
        isClass: false,
        membersAreExports: true,
      });
      return;
    }
    if (isModuleDeclaration(node)) {
      const component = componentOf(node.name);
      if (component === undefined) {
        return;
      }
      const record = declare(node, owner, "namespace", node.name, {
        component,
        localName: undefined,
      });
      exportScopes.push({ owner: record, nameNode: node.name });
      const body = node.body;
      if (body === undefined) {
        return;
      }
      if (isModuleBlock(body)) {
        walkStatements(body.statements, record);
        return;
      }
      walkStatement(body, record);
      return;
    }
    if (isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        const component = componentOf(declaration.name);
        if (component === undefined) {
          // A destructuring pattern declares binding elements, which the reference
          // grammar does not represent; the statement stands for them.
          continue;
        }
        declare(declaration, owner, "variable", declaration.name, {
          component,
          localName: undefined,
        });
      }
      return;
    }
    if (isExportDeclaration(node)) {
      walkExportDeclaration(node, owner);
      return;
    }
    if (isExportAssignment(node) && !node.isExportEquals) {
      declare(node, owner, "export-alias", undefined, {
        component: { text: "default", computed: false },
        localName: undefined,
      });
    }
  }

  function walkExportDeclaration(
    node: { readonly exportClause?: Node; readonly moduleSpecifier?: Node },
    owner: Building,
  ): void {
    const clause = node.exportClause;
    if (clause === undefined) {
      const specifier = node.moduleSpecifier;
      starReExports.push(specifier === undefined ? "" : literalTextOf(specifier));
      return;
    }
    if (isNamespaceExport(clause)) {
      const component = componentOf(clause.name);
      if (component !== undefined) {
        declare(clause, owner, "export-alias", clause.name, { component, localName: undefined });
      }
      return;
    }
    for (const element of (clause as { readonly elements?: readonly Node[] }).elements ?? []) {
      const name = nameNodeOf(element);
      const component = componentOf(name);
      if (component !== undefined) {
        declare(element, owner, "export-alias", name, { component, localName: undefined });
      }
    }
  }

  // One batch for every module and every container the walk found, because a
  // checker accessor with an array overload costs one round trip for the batch and
  // one per node without it.
  const batched: Node[] = [
    ...exportScopes.map((scope) => scope.nameNode),
    ...containers.map((container) => container.nameNode).filter((node) => node !== undefined),
  ];
  const handles: Handle<Brand>[] = batched.map((node) => project.handle(node));
  const resolved = project.symbolsAt(handles);
  const symbolOf = new Map<Node, TSSymbol>();
  batched.forEach((node, index) => {
    const symbol = resolved[index];
    if (symbol !== undefined) {
      symbolOf.set(node, symbol);
    }
  });

  let exportTables = 0;
  for (const scope of exportScopes) {
    const symbol = symbolOf.get(scope.nameNode);
    if (symbol === undefined) {
      continue;
    }
    exportTables += 1;
    for (const [, exported] of symbol.getExports()) {
      for (const declaration of exported.declarations) {
        const held = project.declarationAt(declaration);
        if (held === undefined) {
          continue;
        }
        const record = byNode.get(nodeKey(held.node.getSourceFile(), held.node));
        if (record === undefined) {
          continue;
        }
        record.exported = true;
      }
    }
  }

  let memberTables = 0;
  for (const container of containers) {
    const symbol = container.nameNode === undefined ? undefined : symbolOf.get(container.nameNode);
    const seen = new Map<string, Building>();
    if (symbol !== undefined) {
      if (!container.membersAreExports) {
        memberTables += 1;
        outsideOwnFiles += readTable(container, symbol.getMembers(), seen, false);
      }
      if (container.membersAreExports || container.isClass) {
        memberTables += 1;
        outsideOwnFiles += readTable(container, symbol.getExports(), seen, container.isClass);
      }
    }
    completeFromTree(container, seen);
  }

  /**
   * One container's members as its symbol table holds them, each positioned at the
   * declaration the table names. A member with no declaration is the language's own
   * (a class's `prototype`), and a member declared outside the target's own files
   * belongs to another program; neither is a declaration of the target.
   */
  function readTable(
    container: Container,
    table: ReadonlyMap<string, TSSymbol>,
    seen: Map<string, Building>,
    areStatic: boolean,
  ): number {
    let outside = 0;
    for (const [, member] of table) {
      const declarations = member.declarations
        .map((handle) => project.declarationAt(handle))
        .filter((held): held is Handle<Brand> => held !== undefined);
      if (declarations.length === 0) {
        continue;
      }
      const own = declarations.filter((held) => ownFiles.has(held.node.getSourceFile().fileName));
      if (own.length === 0) {
        outside += declarations.length;
        continue;
      }
      for (const held of own) {
        keepMember(container, held.node, seen, areStatic);
      }
    }
    return outside;
  }

  /**
   * One container's members as its own declaration writes them, for the members its
   * symbol table does not hold: a member whose key is computed is bound to the
   * container's type later than the table is built.
   */
  function completeFromTree(container: Container, seen: Map<string, Building>): void {
    for (const member of container.members) {
      keepMember(container, member, seen, (modifiersOf(member) & ModifierFlags.Static) !== 0);
    }
  }

  function keepMember(
    container: Container,
    node: Node,
    seen: Map<string, Building>,
    areStatic: boolean,
  ): void {
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
    const endLine = renderPosition(file, targetRoot, Math.max(node.end - 1, 0)).line;
    if (held !== undefined) {
      // A getter and a setter of one name are one symbol and one reference, so the
      // second declaration widens the first record rather than making a second. Both
      // nodes name that record, so a reading that starts from either one finds it.
      held.endLine = Math.max(held.endLine, endLine);
      byNode.set(nodeKey(file, node), held);
      return;
    }
    const at = name ?? node;
    const record = keep({
      file,
      node,
      module: container.owner.module,
      position: renderPosition(file, targetRoot, at.getStart()),
      endLine,
      kind,
      parentChain: chainOf(container.owner),
      component,
      localName: undefined,
      parent: container.owner,
      visibility: visibilityOf(node, name),
      static: areStatic,
      exported: false,
      typeParameter: undefined,
    });
    seen.set(key, record);
    declareTypeParameters(node, record);
  }

  function memberKindOf(container: Container, node: Node): SymbolKind | undefined {
    if (container.isClass) {
      if (
        isPropertyDeclaration(node) ||
        isMethodDeclaration(node) ||
        isGetAccessorDeclaration(node) ||
        isSetAccessorDeclaration(node)
      ) {
        return classMemberKind(node);
      }
      return undefined;
    }
    if (container.memberKind === "enum-member") {
      return isEnumMember(node) ? "enum-member" : undefined;
    }
    if (isPropertySignatureDeclaration(node) || isMethodSignatureDeclaration(node)) {
      return typeMemberKind(node, container.memberKind === "interface-method");
    }
    if (isGetAccessorDeclaration(node) || isSetAccessorDeclaration(node)) {
      return "type-member";
    }
    return undefined;
  }

  const symbols = building
    .map(render)
    .sort((a, b) => byPosition(a.position, b.position) || (a.ref < b.ref ? -1 : 1));

  return {
    configFile: project.configFile,
    symbols,
    declarations: new Map(
      [...byNode].map(([key, record]) => [key, positionKey(record.position)] as const),
    ),
    cost: { batches: 1, exportTables, memberTables },
    starReExports,
    outsideOwnFiles,
  };
}

/** The chain of components that names one declaration, read from the module inward. */
function chainOf(record: Building): readonly Component[] {
  return [...record.parentChain, record.component];
}

/**
 * One declaration as the inventory reports it. The display name is the chain in the
 * spelling a reference gives it, except where the declaration carries a name of its
 * own the reference does not: a file, whose reference names its module, and a default
 * export, whose reference carries its export name.
 */
function render(record: Building): InventorySymbol {
  const chain = chainOf(record);
  const spelled = chain
    .map((component) =>
      component.computed ? computedComponent(component.text) : nameComponent(component.text),
    )
    .join(".");
  const name =
    record.localName ??
    (record.typeParameter === undefined ? spelled : `${spelled}<${record.typeParameter}>`);
  return {
    id: positionKey(record.position),
    ref: refOf(record, chain),
    name,
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
    return renderRef(record.module, { of: "alias", name: record.component.text });
  }
  return renderRef(record.module, {
    of: "declaration",
    chain,
    static: record.static,
    ...(record.typeParameter === undefined ? {} : { typeParameter: record.typeParameter }),
  });
}
