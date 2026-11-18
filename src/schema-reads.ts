/**
 * What hand-written production code does with the declarations a schema generator wrote,
 * beside the references the reference pass records: the serializer calls of
 * `references-ts.33`, the oneof reads of `references-ts.32`, the uses of the generated
 * declarations no inventory symbol is, and the caps of `references-ts.34`. The carrier
 * sweep reads it (`bindings.14` to `bindings.16`), and the production sweep reads what the
 * writing calls write.
 */

import {
  isArrayBindingPattern,
  isBinaryExpression,
  isBindingElement,
  isCallExpression,
  isClassDeclaration,
  isClassLikeDeclaration,
  isComputedPropertyName,
  isExportDeclaration,
  isExportSpecifier,
  isExpressionWithTypeArguments,
  isFunctionDeclaration,
  isCaseClause,
  isHeritageClause,
  isIdentifier,
  isImportDeclaration,
  isElementAccessExpression,
  isImportEqualsDeclaration,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectBindingPattern,
  isPropertyAccessExpression,
  isPropertyDeclaration,
  isStringLiteral,
  isStringLiteralLikeNode,
  isSwitchStatement,
  isTypeNode,
  isVariableDeclaration,
  ModifierFlags,
  SyntaxKind,
  type BindingElement,
  type CallExpression,
  type Expression,
  type Node,
  type SourceFile,
} from "@typescript/native/ast";
import {
  SymbolFlags,
  TypeFlags,
  type Signature,
  type Symbol as TSSymbol,
  type Type,
} from "@typescript/native/sync";
import { writtenIn, type Bindings, type Bound, type Descriptor, type Member } from "./bindings.ts";
import { admittedKeyNames } from "./element-access.ts";
import { bindingsOf as importBindingsOf } from "./import-bindings.ts";
import { modifiersOf, nameNodeOf, nodeKey, type Inventory } from "./inventory.ts";
import { graphOf } from "./liveness/graph.ts";
import { walk } from "./liveness/reach.ts";
import { relativePath } from "./paths.ts";
import { positionKey, renderPosition } from "./position.ts";
import { isAnswered, UNANSWERED, type Answer } from "./query.ts";
import type { Reference } from "./references.ts";
import type { ProjectView } from "./session.ts";
import { parenthesesRemoved } from "./unwrap.ts";
import { canonicalDeclarations } from "./canonical-order.ts";

/** Hand-code evidence that lowers a consumer's schema finding to possible (`bindings.16`). */
export type Cap = "persistence" | "descriptor-exposure";

/** One read a hand-written declaration makes of a generated one beside its references. */
export interface SchemaRead {
  /** The hand-written declaration, or file, making it. */
  readonly from: string;
  /** The inventory declaration read. */
  readonly to: string;
}

/** One read a hand-written declaration makes of a generated member no inventory symbol is. */
export interface MemberRead {
  readonly from: string;
  /** The member's key (`Member.key`). */
  readonly member: string;
}

/** What one project's hand-written production code does with its generated declarations. */
export interface SchemaFacts {
  readonly reads: readonly SchemaRead[];
  readonly memberReads: readonly MemberRead[];
  /** The inventory declarations a writing call writes, which a read of them does not need. */
  readonly written: readonly string[];
  /** Per consumer record's symbol, the cap hand code gives it. */
  readonly caps: ReadonlyMap<string, Cap>;
}

/** The facts of a project whose generated files publish no consumer. */
const NO_SCHEMA_FACTS: SchemaFacts = {
  reads: [],
  memberReads: [],
  written: [],
  caps: new Map(),
};

/** What a serializer call does with every field reachable from its message (`bindings.15`). */
type Effect = "reads" | "writes" | "passes";

/**
 * The serializers of `references-ts.33` by name: the protobuf-es functions and message
 * methods, which `@bufbuild/protobuf` declares, and ts-proto's generated message functions.
 * A ProtoJSON decoder names the place of its options argument, which `ignoreUnknownFields:
 * true` must set for the decode to drop unknown fields (`references-ts.34`).
 */
const PROTOBUF_ES: ReadonlyMap<string, { readonly effect: Effect; readonly options?: number }> =
  new Map([
    ["toBinary", { effect: "reads" }],
    ["toJson", { effect: "reads" }],
    ["toJsonString", { effect: "reads" }],
    ["equals", { effect: "reads" }],
    ["create", { effect: "writes" }],
    ["fromBinary", { effect: "writes" }],
    ["mergeFromBinary", { effect: "writes" }],
    ["fromJson", { effect: "writes", options: 2 }],
    ["fromJsonString", { effect: "writes", options: 2 }],
    ["mergeFromJson", { effect: "writes", options: 3 }],
    ["clone", { effect: "passes" }],
  ]);

const TS_PROTO: ReadonlyMap<string, Effect> = new Map([
  ["encode", "reads"],
  ["toJSON", "reads"],
  ["decode", "writes"],
  ["fromJSON", "writes"],
  ["fromPartial", "writes"],
  ["create", "writes"],
]);

/** The package whose declarations the protobuf-es serializers are. */
const PROTOBUF_ES_PACKAGE = "/node_modules/@bufbuild/protobuf/";

/** The package whose `FileDescriptorProto` a ts-proto descriptor is encoded by. */
const TS_PROTO_DESCRIPTORS = "/node_modules/ts-proto-descriptors/";

/** Whether an import specifier names one package, as `/node_modules/<name>/` spells it, or one of its subpaths. */
function namesPackage(module: string | undefined, directory: string): boolean {
  const name = directory.slice("/node_modules/".length, -1);
  return module !== undefined && (module === name || module.startsWith(`${name}/`));
}

/** The properties of a protobuf-es enum descriptor that list every value (`references-ts.33`). */
const ENUM_VALUE_LISTS: ReadonlySet<string> = new Set(["values", "value"]);

/** The operators of a comparison that tells a oneof constituent apart by its discriminant. */
const COMPARISONS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsEqualsToken,
  SyntaxKind.EqualsEqualsToken,
  SyntaxKind.ExclamationEqualsToken,
]);

/** The string a literal writes, or undefined for any other node. */
function literalText(node: Node): string | undefined {
  const at = parenthesesRemoved(node);
  return isStringLiteral(at) || isNoSubstitutionTemplateLiteral(at) ? at.text : undefined;
}

/** The member one property access or literal element access names, the node naming it and the object it is read from. */
function accessedName(
  node: Node,
): { readonly name: string; readonly node: Node; readonly holder: Expression } | undefined {
  if (isPropertyAccessExpression(node)) {
    return isIdentifier(node.name)
      ? { name: node.name.text, node: node.name, holder: node.expression }
      : undefined;
  }
  if (isElementAccessExpression(node)) {
    const key = parenthesesRemoved(node.argumentExpression);
    const text = literalText(key);
    return text === undefined ? undefined : { name: text, node: key, holder: node.expression };
  }
  return undefined;
}

/**
 * The literals a discriminant access is compared with, or undefined where it is compared
 * with none or with something no literal writes, which tells no constituent apart.
 */
function comparedWith(access: Node): readonly string[] | undefined {
  let at = access;
  while (at.parent.kind === SyntaxKind.ParenthesizedExpression) {
    at = at.parent;
  }
  const parent = at.parent;
  if (isBinaryExpression(parent) && COMPARISONS.has(parent.operatorToken.kind)) {
    const other = parent.left === at ? parent.right : parent.left;
    const text = literalText(other);
    return text === undefined ? undefined : [text];
  }
  if (isSwitchStatement(parent) && parent.expression === at) {
    const labels: string[] = [];
    for (const clause of parent.caseBlock.clauses) {
      if (!isCaseClause(clause)) {
        continue;
      }
      const text = literalText(clause.expression);
      if (text === undefined) {
        return undefined;
      }
      labels.push(text);
    }
    return labels;
  }
  return undefined;
}

/** Whether one property access is the target of a plain assignment, which writes it alone. */
function assigned(access: Node): boolean {
  const parent = access.parent;
  return (
    isBinaryExpression(parent) &&
    parent.left === access &&
    parent.operatorToken.kind === SyntaxKind.EqualsToken
  );
}

/**
 * Whether one property access is the object of a further property access, through
 * parentheses and non-null assertions, so that access, not this one, says what is read.
 */
function selected(access: Node): boolean {
  let at = access;
  while (
    at.parent.kind === SyntaxKind.ParenthesizedExpression ||
    at.parent.kind === SyntaxKind.NonNullExpression
  ) {
    at = at.parent;
  }
  return (
    (isPropertyAccessExpression(at.parent) || isElementAccessExpression(at.parent)) &&
    at.parent.expression === at
  );
}

/**
 * Whether one reference's node uses what it names as a value: outside a type, an import
 * and a type-only re-export, an exported import alias being a re-export. The reference
 * pass records no type position, so the tree says where one is. A class's `extends`
 * expression is a value though the tree holds it as a heritage type.
 */
function valueUse(node: Node): boolean {
  for (let up: Node | undefined = node; up !== undefined; up = up.parent as Node | undefined) {
    const reexported =
      isImportEqualsDeclaration(up) &&
      !up.isTypeOnly &&
      (modifiersOf(up) & ModifierFlags.Export) !== 0;
    if (isImportDeclaration(up) || (isImportEqualsDeclaration(up) && !reexported)) {
      return false;
    }
    if ((isExportDeclaration(up) || isExportSpecifier(up)) && up.isTypeOnly) {
      return false;
    }
    const heritage = isExpressionWithTypeArguments(up) ? up.parent : undefined;
    const extended =
      heritage !== undefined &&
      isHeritageClause(heritage) &&
      heritage.token === SyntaxKind.ExtendsKeyword &&
      isClassLikeDeclaration(heritage.parent);
    if (!extended && isTypeNode(up)) {
      return false;
    }
  }
  return true;
}

/** Whether one declaration is a protobuf-es v1 message class, which declares a static `typeName`. */
function declaresTypeName(node: Node): boolean {
  return (
    isClassDeclaration(node) &&
    node.members.some(
      (member) =>
        isPropertyDeclaration(member) &&
        (modifiersOf(member) & ModifierFlags.Static) !== 0 &&
        isIdentifier(member.name) &&
        member.name.text === "typeName",
    )
  );
}

/** One name a file's import declarations bind: the export it names, absent for a whole module, and the module's specifier. */
interface Imported {
  readonly imported?: string;
  readonly module: string;
}

/** The names one file's top-level imports bind, by local name. */
function importsOf(file: SourceFile): ReadonlyMap<string, Imported> {
  const found = new Map<string, Imported>();
  for (const binding of importBindingsOf(file)) {
    let at = binding.name.parent as Node | undefined;
    while (at !== undefined && !isImportDeclaration(at)) {
      at = at.parent;
    }
    if (
      at !== undefined &&
      isImportDeclaration(at) &&
      isStringLiteralLikeNode(at.moduleSpecifier)
    ) {
      found.set(binding.name.text, {
        ...(binding.imported === undefined ? {} : { imported: binding.imported }),
        module: at.moduleSpecifier.text,
      });
    }
  }
  return found;
}

/** The schema index one project's reads look generated declarations up in. */
class SchemaIndex {
  readonly byId = new Map<string, Bound[]>();
  readonly byNode = new Map<string, Bound>();
  /** Per oneof property's key, the constituents it holds. */
  readonly oneofs = new Map<string, Bound[]>();
  readonly fields = new Map<string, Bound[]>();
  readonly values = new Map<string, Bound[]>();
  readonly messages = new Map<string, Bound[]>();
  readonly spelled = new Set<string>();
  /** Per field's name, the full names of the messages its type names. */
  readonly types = new Map<string, Set<string>>();

  readonly bindings: Bindings;

  constructor(bindings: Bindings, references: readonly Reference[]) {
    this.bindings = bindings;
    const holder = (name: string): string => name.slice(0, Math.max(0, name.lastIndexOf(".")));
    for (const bound of bindings.bound) {
      for (const id of bound.ids) {
        this.byId.set(id, [...(this.byId.get(id) ?? []), bound]);
      }
      for (const member of bound.members) {
        this.byNode.set(member.key, bound);
      }
      for (const name of bound.spelled) {
        this.spelled.add(name);
      }
      if (bound.oneof !== undefined) {
        const { holder, holderName } = bound.oneof;
        this.oneofs.set(holder, [...(this.oneofs.get(holder) ?? []), bound]);
        this.spelled.add(holderName);
      }
      const into =
        bound.kind === "field"
          ? this.fields
          : bound.kind === "value"
            ? this.values
            : bound.kind === "message"
              ? this.messages
              : undefined;
      const key = bound.kind === "message" ? bound.name : holder(bound.name);
      into?.set(key, [...(into.get(key) ?? []), bound]);
    }
    const fieldOf = new Map<string, string[]>();
    const membersWithin = new Map<string, { readonly member: Member; readonly field: string }[]>();
    for (const field of [...this.fields.values()].flat()) {
      for (const id of field.ids) {
        fieldOf.set(id, [...(fieldOf.get(id) ?? []), field.name]);
      }
      for (const member of field.members) {
        const known = membersWithin.get(member.within) ?? [];
        membersWithin.set(member.within, [...known, { member, field: field.name }]);
      }
    }
    for (const reference of references) {
      const typed = this.byId.get(reference.to)?.filter((one) => one.kind === "message") ?? [];
      if (typed.length === 0) {
        continue;
      }
      const named = [
        ...(fieldOf.get(reference.from) ?? []),
        ...(membersWithin.get(reference.from) ?? [])
          .filter((one) => writtenIn(one.member, reference))
          .map((one) => one.field),
      ];
      for (const field of named) {
        const types = this.types.get(field) ?? new Set<string>();
        for (const one of typed) {
          types.add(one.name);
        }
        this.types.set(field, types);
      }
    }
  }

  /** The messages reachable from some through field types, themselves included. */
  closure(messages: Iterable<string>): ReadonlySet<string> {
    const reached = new Set<string>();
    const queue = [...messages];
    for (let name = queue.pop(); name !== undefined; name = queue.pop()) {
      if (reached.has(name)) {
        continue;
      }
      reached.add(name);
      for (const field of this.fields.get(name) ?? []) {
        queue.push(...(this.types.get(field.name) ?? []));
      }
    }
    return reached;
  }

  /** Every message the project's generated files declare. */
  allMessages(): readonly string[] {
    return [...this.messages.keys()];
  }

  /** Every enum whose values the project's generated files declare. */
  allEnums(): readonly string[] {
    return [...this.values.keys()];
  }
}

/** What one project's walk gathers, then answers as its facts. */
class Gathered {
  readonly reads: SchemaRead[] = [];
  readonly memberReads: MemberRead[] = [];
  readonly written = new Set<string>();
  readonly caps = new Map<string, Cap>();

  readonly index: SchemaIndex;

  constructor(index: SchemaIndex) {
    this.index = index;
  }

  /** A read of one consumer, through every declaration standing for it. */
  read(from: string, bound: Bound): void {
    for (const id of bound.ids) {
      this.reads.push({ from, to: id });
    }
    for (const member of bound.members) {
      this.memberReads.push({ from, member: member.key });
    }
  }

  /** What one serializer call does with every field of the messages it names. */
  serialize(from: string, messages: readonly string[], effect: Effect, persists: boolean): void {
    const closure = this.index.closure(messages);
    for (const message of closure) {
      for (const field of this.index.fields.get(message) ?? []) {
        if (effect === "reads") {
          this.read(from, field);
        } else if (effect === "writes") {
          for (const id of field.ids) {
            this.written.add(id);
          }
        }
      }
      if (persists) {
        for (const one of [
          ...(this.index.messages.get(message) ?? []),
          ...(this.index.fields.get(message) ?? []),
        ]) {
          this.caps.set(one.symbol, "persistence");
        }
      }
    }
  }

  /** Marks every consumer of one generated file as serving its descriptors. */
  expose(path: string): void {
    for (const bound of this.index.bindings.bound) {
      if (bound.path === path && this.caps.get(bound.symbol) !== "persistence") {
        this.caps.set(bound.symbol, "descriptor-exposure");
      }
    }
  }

  facts(): SchemaFacts {
    return {
      reads: this.reads,
      memberReads: this.memberReads,
      written: [...this.written],
      caps: this.caps,
    };
  }
}

/** One member a destructuring names by literal text that may name a generated declaration. */
interface Pattern {
  readonly element: BindingElement;
  readonly name: string;
  readonly from: string;
}

/** One read of an enum descriptor's value list by name, or of what may be one. */
interface EnumList {
  /** The value or pattern whose type holds the list. */
  readonly holder: Node;
  /** The expression the holder's value is, whose symbol may name the descriptor. */
  readonly source: Expression | undefined;
  /** The name a property access writes, whose symbol is the list's. */
  readonly property?: Node;
  readonly name: string;
  readonly from: string;
}

/** One element access, or computed destructured property, whose key is no literal text. */
interface Keyed {
  readonly key: Expression;
  /** The value or pattern the member is read from. */
  readonly holder: Node;
  readonly access: Node | undefined;
  /** Whether the read takes the member's value whole. */
  readonly whole: boolean;
  readonly from: string;
}

/** Whether a destructured property is itself destructured, so its own pattern says what is read. */
function nestsPattern(element: BindingElement): boolean {
  return (
    element.name !== undefined &&
    (isObjectBindingPattern(element.name) || isArrayBindingPattern(element.name))
  );
}

/** One value-position reference of hand code to descriptor constants, with the calls whose arguments hold it. */
interface DescriptorUse {
  readonly descriptors: readonly Descriptor[];
  readonly calls: readonly CallExpression[];
}

/** One call as the walk found it, before its callee is resolved. */
interface CallSite {
  readonly call: CallExpression;
  readonly from: string;
  /** The callee's name as the call spells it, through a renaming import; absent where it spells none. */
  readonly spelled?: string;
  /** The receiver of a method form, the message type's holder. */
  readonly receiver: Expression | undefined;
  /** The specifier of the module a callee named by an import, or through a namespace import, comes from. */
  readonly module?: string;
  /** The specifier of the module whose import names the receiver's leftmost name. */
  readonly receiverModule?: string;
}

/**
 * One serializer call: its callee's name as the declaration of the signature the call
 * resolves to spells it, or the call's own spelling where the checker names none.
 */
interface Call extends CallSite {
  readonly name: string;
  readonly signature: Signature | undefined;
  /** The resolved signature's declaration; undefined where the checker named none. */
  readonly declaration: Node | undefined;
}

/** Whether one name is a serializer's of `references-ts.33`. */
function serializerNamed(name: string): boolean {
  return PROTOBUF_ES.has(name) || TS_PROTO.has(name);
}

/** The module whose import names a receiver's leftmost name, through member accesses. */
function receiverModuleOf(
  receiver: Expression,
  imports: ReadonlyMap<string, Imported>,
): { readonly receiverModule?: string } {
  let at: Node = parenthesesRemoved(receiver);
  for (let accessed = accessedName(at); accessed !== undefined; accessed = accessedName(at)) {
    at = parenthesesRemoved(accessed.holder);
  }
  const module = isIdentifier(at) ? imports.get(at.text)?.module : undefined;
  return module === undefined ? {} : { receiverModule: module };
}

/**
 * One call expression as a call site, with what its spelling and the file's imports say,
 * which name a serializer only where the checker resolves the call to no declaration.
 */
function callSiteOf(
  node: CallExpression,
  from: string,
  imports: ReadonlyMap<string, Imported>,
): CallSite {
  const callee = parenthesesRemoved(node.expression);
  if (isIdentifier(callee)) {
    const binding = imports.get(callee.text);
    return binding === undefined
      ? { call: node, from, spelled: callee.text, receiver: undefined }
      : {
          call: node,
          from,
          ...(binding.imported === undefined ? {} : { spelled: binding.imported }),
          receiver: undefined,
          module: binding.module,
        };
  }
  const accessed = accessedName(callee);
  if (accessed === undefined) {
    return { call: node, from, receiver: undefined };
  }
  const holder = parenthesesRemoved(accessed.holder);
  const binding = isIdentifier(holder) ? imports.get(holder.text) : undefined;
  return binding !== undefined && binding.imported === undefined
    ? { call: node, from, spelled: accessed.name, receiver: undefined, module: binding.module }
    : {
        call: node,
        from,
        spelled: accessed.name,
        receiver: accessed.holder,
        ...receiverModuleOf(accessed.holder, imports),
      };
}

/**
 * Where hand code references descriptor constants (`references-ts.34`), by rendered
 * position: each production read the reference pass resolved, through any alias,
 * shorthand, destructuring or namespace, to a descriptor constant, and each read of a
 * generated file that reads every export, whose protobuf-es `GenFile` exports it reads.
 * A judged read of a namespace object names no export, and a re-export or an alias
 * declaration is no use unless code the analysis does not see uses its source (`reach.ts`).
 */
function descriptorReferences(
  held: Inventory,
  bindings: Bindings,
  references: readonly Reference[],
  seeds: Iterable<string>,
): {
  readonly uses: ReadonlyMap<string, readonly Descriptor[]>;
  readonly paths: ReadonlySet<string>;
} {
  const parents = new Map(held.symbols.map((one) => [one.id, one.parent]));
  const byFile = new Map<string, Descriptor[]>();
  for (const [id, descriptor] of bindings.descriptors) {
    const file = parents.get(id);
    if (file !== undefined && descriptor.exposedBy === "value") {
      byFile.set(file, [...(byFile.get(file) ?? []), descriptor]);
    }
  }
  const uses = new Map<string, Descriptor[]>();
  const paths = new Set<string>();
  // `references-ts.34` counts hand code's use whatever reaches it, so every declaration is a seed.
  const graph = graphOf(held.symbols, references, [], []);
  const { used } = walk(graph, {
    seeds: [
      ...[...seeds].map((id) => ({
        at: graph.at(id),
        holds: false,
        used: true,
        origin: undefined,
      })),
      ...graph.symbols.map((_one, at) => ({ at, holds: false, used: false, origin: undefined })),
    ],
    follows: (edge) => !edge.test && !edge.consumer,
  });
  for (const reference of references) {
    const published = reference.reexport === true && used[graph.at(reference.from)] === true;
    if (
      reference.test ||
      reference.consumer !== undefined ||
      reference.use !== "read" ||
      (reference.reexport === true && !published)
    ) {
      continue;
    }
    const constant = bindings.descriptors.get(reference.to);
    const found =
      constant !== undefined
        ? [constant]
        : reference.namespace === true && !published
          ? []
          : (byFile.get(reference.to) ?? []);
    if (found.length > 0) {
      const key = positionKey(reference.position);
      uses.set(key, [...(uses.get(key) ?? []), ...found]);
      paths.add(reference.position.path);
    }
  }
  return { uses, paths };
}

/**
 * What one project's hand-written production files do with its generated declarations:
 * `files` the files to read, below the target `root`, `generated` whether a file is one of
 * the project's generated files, `references` the project's, which give each field's type
 * and each use of a descriptor constant, and `seeds` the declarations code the analysis does
 * not see uses: those its roots name, and those an unanswered question holds.
 */
export function schemaFacts<Brand>(
  project: ProjectView<Brand>,
  held: Inventory,
  root: string,
  files: readonly SourceFile[],
  generated: (file: SourceFile) => boolean,
  bindings: Bindings,
  references: readonly Reference[],
  seeds: Iterable<string>,
): SchemaFacts {
  if (bindings.bound.length === 0) {
    return NO_SCHEMA_FACTS;
  }
  const index = new SchemaIndex(bindings, references);
  const gathered = new Gathered(index);
  const { queries } = project;
  const descriptorUses = descriptorReferences(held, bindings, references, seeds);

  /** The declaration nodes one symbol names, through the alias it may be. */
  const declarationsOf = (symbol: Answer<TSSymbol | undefined>): readonly Node[] | undefined => {
    if (!isAnswered(symbol)) {
      return undefined;
    }
    if (symbol === undefined) {
      return [];
    }
    const target = (symbol.flags & SymbolFlags.Alias) === 0 ? symbol : queries.aliased(symbol);
    if (!isAnswered(target)) {
      return undefined;
    }
    return canonicalDeclarations(target).flatMap(
      (handle) => project.declarationAt(handle)?.node ?? [],
    );
  };
  const idOf = (node: Node): string | undefined =>
    held.declarations.get(nodeKey(node.getSourceFile(), node));
  const boundOf = (nodes: readonly Node[]): readonly Bound[] =>
    nodes.flatMap((node) => {
      const id = idOf(node);
      return id === undefined ? [] : (index.byId.get(id) ?? []);
    });

  for (const file of files) {
    const fileId = idOf(file) ?? "";
    const fromOf = (node: Node): string => {
      for (let up = node.parent as Node | undefined; up !== undefined; up = up.parent) {
        const id = idOf(up);
        if (id !== undefined) {
          return id;
        }
      }
      return fileId;
    };
    const names: {
      readonly node: Node;
      readonly name: string;
      readonly from: string;
      readonly access: Node;
    }[] = [];
    const patterns: Pattern[] = [];
    const sites: CallSite[] = [];
    const lists: EnumList[] = [];
    const keyed: Keyed[] = [];
    const descriptors: DescriptorUse[] = [];
    const path = relativePath(root, file.fileName) ?? "";
    const used = descriptorUses.paths.has(path);
    const matched = new Set<string>();
    const imports = importsOf(file);
    const visit = (node: Node, holding: readonly CallExpression[]): void => {
      const accessed = accessedName(node);
      if (accessed !== undefined && !assigned(node)) {
        if (index.spelled.has(accessed.name)) {
          names.push({
            node: accessed.node,
            name: accessed.name,
            from: fromOf(node),
            access: node,
          });
        }
        if (ENUM_VALUE_LISTS.has(accessed.name)) {
          lists.push({
            holder: accessed.holder,
            source: accessed.holder,
            property: accessed.node,
            name: accessed.name,
            from: fromOf(node),
          });
        }
      } else if (isElementAccessExpression(node) && !assigned(node)) {
        keyed.push({
          key: node.argumentExpression,
          holder: node.expression,
          access: node,
          whole: !selected(node),
          from: fromOf(node),
        });
      }
      if (isBindingElement(node) && isObjectBindingPattern(node.parent)) {
        const property = node.propertyName ?? node.name;
        const computed =
          property !== undefined && isComputedPropertyName(property)
            ? property.expression
            : undefined;
        const name =
          computed !== undefined
            ? literalText(computed)
            : property !== undefined &&
                (isIdentifier(property) || isStringLiteral(property) || isNumericLiteral(property))
              ? property.text
              : undefined;
        const declaration = node.parent.parent;
        if (name !== undefined && index.spelled.has(name)) {
          patterns.push({ element: node, name, from: fromOf(node) });
        }
        if (name !== undefined && ENUM_VALUE_LISTS.has(name)) {
          lists.push({
            holder: node.parent,
            source:
              isVariableDeclaration(declaration) && declaration.name === node.parent
                ? declaration.initializer
                : undefined,
            name,
            from: fromOf(node),
          });
        }
        if (name === undefined && computed !== undefined) {
          keyed.push({
            key: computed,
            holder: node.parent,
            access: undefined,
            whole: !nestsPattern(node),
            from: fromOf(node),
          });
        }
      }
      // A dynamic import loads a module and calls no function.
      if (isCallExpression(node) && node.expression.kind !== SyntaxKind.ImportKeyword) {
        sites.push(callSiteOf(node, fromOf(node), imports));
      }
      // Nodes sharing a start share their enclosing calls, so the outermost stands for all.
      const key = used ? positionKey(renderPosition(file, root, node.getStart())) : undefined;
      const uses = key === undefined || matched.has(key) ? undefined : descriptorUses.uses.get(key);
      if (key !== undefined) {
        matched.add(key);
      }
      if (uses !== undefined && valueUse(node)) {
        descriptors.push({ descriptors: uses, calls: holding });
      }
      node.forEachChild((child) => {
        visit(
          child,
          !isCallExpression(node) || child === node.expression ? holding : [...holding, node],
        );
      });
    };
    file.forEachChild((child) => {
      visit(child, []);
    });

    readNames(names);
    readPatterns(patterns);
    readKeyed(keyed);
    readLists(lists);
    readCalls(sites, descriptors);
  }
  return gathered.facts();

  /** The reads of the property-access names that may name a generated declaration no inventory symbol is. */
  function readNames(
    names: readonly {
      readonly node: Node;
      readonly name: string;
      readonly from: string;
      readonly access: Node;
    }[],
  ): void {
    const symbols = queries.symbolsAt(names.map((one) => one.node));
    names.forEach((one, at) => {
      const symbol = symbols[at];
      // The checker names no symbol for a member of an untyped value, so `anyValue.value` may
      // read any member it spells that no inventory symbol is, each oneof constituent's `value`.
      const declared = symbol === undefined ? undefined : declarationsOf(symbol);
      if (declared === undefined) {
        readSpelled(one.from, one.name);
        return;
      }
      readDeclared(one.from, one.name, declared, one.access, !selected(one.access));
    });
  }

  /** The reads of the destructured properties that may name such a declaration. */
  function readPatterns(patterns: readonly Pattern[]): void {
    const types = queries.typesAt(patterns.map((one) => one.element.parent));
    patterns.forEach((one, at) => {
      const type = types[at];
      const properties =
        type === undefined || !isAnswered(type) ? UNANSWERED : queries.propertiesOf(type);
      if (properties === UNANSWERED) {
        readSpelled(one.from, one.name);
        return;
      }
      const property = properties.find((candidate) => candidate.name === one.name);
      const declared = property === undefined ? [] : declarationsOf(property);
      if (declared === undefined) {
        readSpelled(one.from, one.name);
      } else {
        readDeclared(one.from, one.name, declared, undefined, !nestsPattern(one.element));
      }
    });
  }

  /** Where the checker did not answer, a read of every such declaration so spelled. */
  function readSpelled(from: string, name: string): void {
    for (const bound of index.bindings.bound) {
      if (bound.spelled.includes(name) || bound.oneof?.holderName === name) {
        gathered.read(from, bound);
      }
    }
  }

  /**
   * The reads one use of the declarations named makes: a service type's method member, a
   * member of a oneof constituent, a discriminant compared with literals reading only the
   * constituents they name (`references-ts.32`), and, where the use reads its value whole,
   * a oneof's property, which tells no constituent apart (`bindings.14`).
   */
  function readDeclared(
    from: string,
    name: string,
    declared: readonly Node[],
    access: Node | undefined,
    whole: boolean,
  ): void {
    const constituents: Bound[] = [];
    for (const node of declared) {
      const key = nodeKey(node.getSourceFile(), node);
      const own = index.byNode.get(key);
      if (own !== undefined) {
        gathered.read(from, own);
      }
      for (const one of whole ? (index.oneofs.get(key) ?? []) : []) {
        gathered.read(from, one);
      }
      const parent = node.parent as Node | undefined;
      const constituent =
        parent === undefined ? undefined : index.byNode.get(nodeKey(node.getSourceFile(), parent));
      if (constituent !== undefined) {
        constituents.push(constituent);
      }
    }
    const discriminant = constituents.some((one) => one.oneof?.property === name);
    const literals = discriminant && access !== undefined ? comparedWith(access) : undefined;
    for (const one of constituents) {
      if (literals === undefined || literals.includes(one.oneof?.literal ?? "")) {
        gathered.read(from, one);
      }
    }
  }

  /**
   * The reads of the members an element access or a computed destructured property names
   * by a key that is not literal text: each member of the holder's type the key's type
   * admits ({@link admittedKeyNames}), every member and enum value list so spelled where it
   * admits every name or the checker did not answer.
   */
  function readKeyed(keys: readonly Keyed[]): void {
    const types = queries.typesAt(keys.map((one) => one.key));
    const named: { readonly one: Keyed; readonly name: string }[] = [];
    keys.forEach((one, at) => {
      const type = types[at];
      const admitted =
        type === undefined || !isAnswered(type) ? type : admittedKeyNames(queries, type);
      const names: readonly string[] | undefined =
        admitted === "every"
          ? [...index.spelled, ...ENUM_VALUE_LISTS]
          : admitted instanceof Set
            ? [...admitted]
            : admitted === undefined
              ? []
              : undefined;
      if (names === undefined) {
        for (const name of index.spelled) {
          readSpelled(one.from, name);
        }
        readValues(one.from, index.allEnums());
        return;
      }
      for (const name of names) {
        named.push({ one, name });
      }
    });
    const holders = queries.typesAt(named.map(({ one }) => one.holder));
    const lists: EnumList[] = [];
    named.forEach(({ one, name }, at) => {
      if (ENUM_VALUE_LISTS.has(name)) {
        lists.push({ holder: one.holder, source: undefined, name, from: one.from });
      }
      if (!index.spelled.has(name)) {
        return;
      }
      const holder = holders[at];
      const properties =
        isAnswered(holder) && holder !== undefined ? queries.propertiesOf(holder) : UNANSWERED;
      if (!isAnswered(properties)) {
        readSpelled(one.from, name);
        return;
      }
      const property = properties.find((candidate) => candidate.name === name);
      const declared = property === undefined ? [] : declarationsOf(property);
      if (declared === undefined) {
        readSpelled(one.from, name);
      } else {
        readDeclared(one.from, name, declared, one.access, one.whole);
      }
    });
    readLists(lists);
  }

  /** The reads of every value of some enums, by full name. */
  function readValues(from: string, enums: readonly string[]): void {
    for (const name of enums) {
      for (const value of index.values.get(name) ?? []) {
        gathered.read(from, value);
      }
    }
  }

  /**
   * The values a read of an enum descriptor's value list reads: every value of the enum
   * (`references-ts.33`), the descriptor named by the symbol its holder resolves to, or else
   * by the type arguments of the holder's type where the property read is the one
   * `@bufbuild/protobuf` declares; every enum's where that type names no enum (a
   * `DescEnum`) or the checker did not answer. The enum-group class owns a name conversion
   * and a lookup by an index no literal writes, whose record the carrier sweep reads.
   */
  function readLists(lists: readonly EnumList[]): void {
    const bySymbol = resolvedAt(lists.map((one) => one.source));
    const unresolved = lists.flatMap((one, at) =>
      boundIn(bySymbol[at]).some((bound) => bound.kind === "enum") ? [] : [one],
    );
    lists.forEach((one, at) => {
      const enums = boundIn(bySymbol[at]).filter((bound) => bound.kind === "enum");
      readValues(
        one.from,
        enums.map((bound) => bound.name),
      );
    });
    const holders = queries.typesAt(unresolved.map((one) => one.holder));
    const accessed = unresolved.flatMap((one) =>
      one.property === undefined ? [] : [one.property],
    );
    const accessedSymbols = queries.symbolsAt(accessed);
    let next = 0;
    unresolved.forEach((one, at) => {
      const holder = holders[at];
      const property =
        one.property === undefined ? propertyNamed(holder, one.name) : accessedSymbols[next++];
      if (!isAnswered(property)) {
        readValues(one.from, index.allEnums());
        return;
      }
      const listed =
        property?.declarations.some((handle) => handle.path.includes(PROTOBUF_ES_PACKAGE)) ?? false;
      if (!listed) {
        return;
      }
      const enums = enumsOfType(holder);
      readValues(one.from, enums ?? index.allEnums());
    });
  }

  /** The property of one name a type has; undefined where it has none. */
  function propertyNamed(
    type: Answer<Type | undefined>,
    name: string,
  ): Answer<TSSymbol | undefined> {
    if (!isAnswered(type) || type === undefined) {
      return isAnswered(type) ? undefined : UNANSWERED;
    }
    const properties = queries.propertiesOf(type);
    return isAnswered(properties)
      ? properties.find((candidate) => candidate.name === name)
      : UNANSWERED;
  }

  /**
   * The bound enums the type arguments and alias arguments of an enum descriptor's type
   * name, none where they name only enums the project does not bind; undefined where they
   * name no enum (a `DescEnum`) or the checker did not answer, which reads as every enum.
   */
  function enumsOfType(type: Answer<Type | undefined>): readonly string[] | undefined {
    if (!isAnswered(type) || type === undefined) {
      return undefined;
    }
    const aliasArguments = queries.aliasArgumentsOf(type);
    const typeArguments = queries.typeArguments(type);
    if (!isAnswered(aliasArguments) || !isAnswered(typeArguments)) {
      return undefined;
    }
    const found = new Set<string>();
    let named = false;
    for (const part of [...aliasArguments, ...typeArguments]) {
      const declared = declaredBy(part);
      if (declared === undefined) {
        return undefined;
      }
      named ||= (part.flags & TypeFlags.EnumLike) !== 0;
      for (const bound of boundOf(declared)) {
        if (bound.kind === "enum") {
          found.add(bound.name);
        }
      }
    }
    return found.size > 0 || named ? [...found] : undefined;
  }

  /** The consumers each expression names, by its symbol, an alias followed; {@link UNANSWERED} where the checker did not answer. */
  function resolved(expressions: readonly Expression[]): readonly Answer<readonly Bound[]>[] {
    const named = expressions.map((one) => {
      const at = parenthesesRemoved(one);
      return accessedName(at)?.node ?? at;
    });
    const symbols = queries.symbolsAt(named);
    return named.map((_node, at) => {
      const declared = declarationsOf(symbols[at]);
      return declared === undefined ? UNANSWERED : boundOf(declared);
    });
  }

  /** {@link resolved} over places some of which hold no expression, which name none. */
  function resolvedAt(
    places: readonly (Expression | undefined)[],
  ): readonly Answer<readonly Bound[]>[] {
    const present = places.flatMap((one) => (one === undefined ? [] : [one]));
    const answers = resolved(present);
    let next = 0;
    return places.map((one) => (one === undefined ? [] : (answers[next++] ?? UNANSWERED)));
  }

  /** The consumers an answer names, none where the checker did not answer. */
  function boundIn(answer: Answer<readonly Bound[]> | undefined): readonly Bound[] {
    return answer === undefined || !isAnswered(answer) ? [] : answer;
  }

  /**
   * Whether one type is a message's: a protobuf-es v2 message shape, whose `$typeName` is a
   * literal, or a protobuf-es v1 message class.
   */
  function isMessageType(type: Type): boolean {
    const typeName = queries.propertyTypeOf(type, "$typeName");
    if (isAnswered(typeName) && typeName !== undefined) {
      return (typeName.flags & TypeFlags.StringLiteral) !== 0;
    }
    return (declarationsOf(queries.symbolOfType(type)) ?? []).some(declaresTypeName);
  }

  /** The declarations of the alias one type was instantiated from and of its own symbol; undefined where the checker did not answer. */
  function declaredBy(type: Type): readonly Node[] | undefined {
    const alias = declarationsOf(queries.aliasSymbolOf(type));
    const own = declarationsOf(queries.symbolOfType(type));
    return alias === undefined || own === undefined ? undefined : [...alias, ...own];
  }

  /** The full names of the bound messages some declarations stand for. */
  function messagesIn(nodes: readonly Node[]): readonly string[] {
    return boundOf(nodes)
      .filter((one) => one.kind === "message")
      .map((one) => one.name);
  }

  /**
   * The bound messages some messages of the project's unbound generated files reach
   * through field types (`bindings.15`): through unions, type arguments and alias
   * arguments, and the properties and index signatures of an object type a generated file
   * of the project declares, which alone has them walked; a bound message ends a path.
   * Undefined where the checker did not answer.
   */
  function reachedFrom(messages: readonly Type[]): readonly string[] | undefined {
    const found = new Set<string>();
    const seen = new Set<number>();
    const queue = [...messages];
    for (let type = queue.pop(); type !== undefined; type = queue.pop()) {
      if (seen.has(type.id)) {
        continue;
      }
      seen.add(type.id);
      const declared = declaredBy(type);
      const constituents = queries.constituents(type);
      const typeArguments = queries.typeArguments(type);
      const aliasArguments = queries.aliasArgumentsOf(type);
      if (
        declared === undefined ||
        !isAnswered(constituents) ||
        !isAnswered(typeArguments) ||
        !isAnswered(aliasArguments)
      ) {
        return undefined;
      }
      const named = messagesIn(declared);
      if (named.length > 0) {
        for (const name of named) {
          found.add(name);
        }
        continue;
      }
      queue.push(
        ...constituents.filter((one) => one.id !== type.id),
        ...typeArguments,
        ...aliasArguments,
      );
      if (
        (type.flags & TypeFlags.Object) === 0 ||
        !declared.some((node) => generated(node.getSourceFile()))
      ) {
        continue;
      }
      const properties = queries.propertiesOf(type);
      const infos = queries.indexInfosOf(type);
      if (!isAnswered(properties) || !isAnswered(infos)) {
        return undefined;
      }
      for (const property of properties) {
        const held =
          (property.flags & SymbolFlags.Property) === 0
            ? undefined
            : queries.typeOfSymbol(property);
        if (held !== undefined && !isAnswered(held)) {
          return undefined;
        }
        if (held !== undefined) {
          queue.push(held);
        }
      }
      queue.push(...infos.map((info) => info.valueType));
    }
    return [...found];
  }

  /**
   * The messages a type names: its own and those its type arguments and alias arguments
   * name, a message of an unbound generated file of the project standing for the bound
   * messages it reaches, and none for a message no generated file of the project
   * declares. {@link UNANSWERED} where the checker did not answer, and undefined where it
   * names no message (a `DescMessage`, a type parameter); both read as every message.
   */
  function messageOfType(type: Answer<Type | undefined>): Answer<readonly string[] | undefined> {
    if (!isAnswered(type)) {
      return UNANSWERED;
    }
    if (type === undefined) {
      return undefined;
    }
    const aliasArguments = queries.aliasArgumentsOf(type);
    const typeArguments = queries.typeArguments(type);
    if (!isAnswered(aliasArguments) || !isAnswered(typeArguments)) {
      return UNANSWERED;
    }
    const found = new Set<string>();
    const unbound: Type[] = [];
    let outside = false;
    for (const part of [type, ...aliasArguments, ...typeArguments]) {
      const declared = declaredBy(part);
      if (declared === undefined) {
        return UNANSWERED;
      }
      const named = messagesIn(declared);
      for (const name of named) {
        found.add(name);
      }
      if (named.length === 0 && isMessageType(part)) {
        if (declared.some((node) => generated(node.getSourceFile()))) {
          unbound.push(part);
        } else {
          outside = true;
        }
      }
    }
    if (unbound.length > 0) {
      const reached = reachedFrom(unbound);
      return reached === undefined ? UNANSWERED : [...new Set([...found, ...reached])];
    }
    return found.size > 0 ? [...found] : outside ? [] : undefined;
  }

  /** The messages one serializer call's schema or receiver names: by the symbol it names, else by its type. */
  function messageOf(
    expression: Expression | undefined,
    bound: readonly Bound[],
  ): Answer<readonly string[] | undefined> {
    const named = bound.filter((one) => one.kind === "message").map((one) => one.name);
    if (named.length > 0) {
      return named;
    }
    return expression === undefined ? undefined : messageOfType(queries.typeAt(expression));
  }

  /**
   * The messages a method form called without a receiver names, by its resolved signature:
   * the message its first parameter takes for an encoding call, and the one it returns
   * for any other.
   */
  function messageOfSignature(call: Call, effect: Effect): Answer<readonly string[] | undefined> {
    const { signature } = call;
    if (signature === undefined) {
      return undefined;
    }
    return messageOfType(
      effect === "reads" ? queries.parameterType(signature, 0) : queries.returnTypeOf(signature),
    );
  }

  /**
   * What one serializer call does: a function or method `@bufbuild/protobuf` declares, or a
   * protobuf-es v1 static method or ts-proto message function on a receiver naming the
   * message, or called with none and declared in a generated file of the project. A call
   * the checker names no declaration for is the runtime's function where an import of
   * `@bufbuild/protobuf` names it, and its method where its receiver's type is a message
   * the project binds; an unanswered receiver may name any message.
   */
  function effectOf(
    call: Call,
    resolvedReceiver: Answer<readonly Bound[]>,
  ): { readonly effect: Effect; readonly options?: number } | undefined {
    const file = call.declaration?.getSourceFile();
    const protobufEs = PROTOBUF_ES.get(call.name);
    const undeclared = file === undefined;
    const receiver = boundIn(resolvedReceiver);
    const receivedMessage = (): boolean => {
      const named = call.receiver === undefined ? undefined : messageOf(call.receiver, receiver);
      return named === UNANSWERED || (named !== undefined && named.length > 0);
    };
    if (
      protobufEs !== undefined &&
      ((file?.fileName.includes(PROTOBUF_ES_PACKAGE) ?? false) ||
        (undeclared && namesPackage(call.module, PROTOBUF_ES_PACKAGE)) ||
        (undeclared && receivedMessage()))
    ) {
      return protobufEs;
    }
    // A method value called with no receiver, destructured or held, names its message by its signature.
    const unreceived = call.receiver === undefined && file !== undefined && generated(file);
    if (
      isAnswered(resolvedReceiver) &&
      !receiver.some((one) => one.kind === "message") &&
      !unreceived
    ) {
      return undefined;
    }
    const tsProto = TS_PROTO.get(call.name);
    return tsProto === undefined ? protobufEs : { effect: tsProto };
  }

  /**
   * Whether a ProtoJSON decode's options drop unknown fields: the checker types their
   * `ignoreUnknownFields` as the literal `true`. A widened `boolean`, or a type the checker
   * did not answer for, keeps them.
   */
  function dropsUnknown(options: Expression | undefined): boolean {
    if (options === undefined) {
      return false;
    }
    const type = queries.typeAt(options);
    const flag =
      isAnswered(type) && type !== undefined
        ? queries.propertyTypeOf(type, "ignoreUnknownFields")
        : UNANSWERED;
    return isAnswered(flag) && flag !== undefined && flag.isBooleanLiteralType() && flag.value;
  }

  /**
   * The generated files whose descriptors hand code exposes (`references-ts.34`): by a value
   * use of a protobuf-es file descriptor constant, and by a ts-proto `protoMetadata` read
   * inside an argument of a ts-proto-descriptors encoder call, which `encoders` names.
   */
  function readDescriptors(
    descriptors: readonly DescriptorUse[],
    encoders: ReadonlySet<CallExpression>,
  ): void {
    for (const use of descriptors) {
      const encoded = use.calls.some((call) => encoders.has(call));
      for (const descriptor of use.descriptors) {
        if (descriptor.exposedBy === "value" || encoded) {
          gathered.expose(descriptor.path);
        }
      }
    }
  }

  /**
   * The serializer calls among some call sites, by the signature each resolves to, which
   * follows any alias, destructuring or value binding of the callee (`references-ts.22`),
   * and by the call's own spelling where the checker does not answer or names no
   * declaration; `unanswered` holds the sites whose signature the checker did not answer.
   */
  function serializersAmong(sites: readonly CallSite[]): {
    readonly calls: readonly Call[];
    readonly unanswered: readonly CallSite[];
  } {
    const signatures = queries.resolvedSignatures(sites.map((one) => one.call));
    const unanswered = sites.filter((_site, at) => signatures[at] === UNANSWERED);
    const calls = sites.flatMap((site, at) => {
      const answer = signatures[at];
      const signature = answer === undefined || !isAnswered(answer) ? undefined : answer;
      const handle = signature?.declaration;
      const declaration = handle === undefined ? undefined : project.declarationAt(handle)?.node;
      const named = declaration === undefined ? undefined : nameNodeOf(declaration);
      const name =
        declaration === undefined
          ? site.spelled
          : named !== undefined && (isIdentifier(named) || isStringLiteral(named))
            ? named.text
            : undefined;
      return name !== undefined && serializerNamed(name)
        ? [{ ...site, name, signature, declaration }]
        : [];
    });
    return { calls, unanswered };
  }

  /** Each serializer call's effect, and the file descriptors hand code exposes. */
  function readCalls(sites: readonly CallSite[], descriptors: readonly DescriptorUse[]): void {
    const { calls, unanswered } = serializersAmong(sites);
    // A call whose signature went unanswered may be any serializer, of any message.
    for (const site of unanswered) {
      gathered.serialize(site.from, index.allMessages(), "reads", false);
    }
    const receivers = resolvedAt(calls.map((one) => one.receiver));
    const firsts = resolvedAt(calls.map((one) => one.call.arguments[0]));
    const encoders = new Set<CallExpression>();
    calls.forEach((one, at) => {
      const path = one.declaration?.getSourceFile().fileName;
      // A function names its schema first; a method's receiver holds the message.
      const method =
        one.declaration === undefined
          ? one.receiver !== undefined
          : !isFunctionDeclaration(one.declaration);
      if (
        TS_PROTO.get(one.name) === "reads" &&
        ((path?.includes(TS_PROTO_DESCRIPTORS) ?? false) ||
          (path === undefined && namesPackage(one.receiverModule, TS_PROTO_DESCRIPTORS)))
      ) {
        encoders.add(one.call);
        return;
      }
      const receiver = receivers[at] ?? UNANSWERED;
      const found = effectOf(one, receiver);
      if (found === undefined) {
        return;
      }
      const named = !method
        ? messageOf(one.call.arguments[0], boundIn(firsts[at]))
        : one.receiver === undefined
          ? messageOfSignature(one, found.effect)
          : messageOf(one.receiver, boundIn(receiver));
      const messages = isAnswered(named) && named !== undefined ? named : index.allMessages();
      const options =
        found.options === undefined
          ? undefined
          : one.call.arguments[method ? found.options - 1 : found.options];
      const persists = found.options !== undefined && !dropsUnknown(options);
      gathered.serialize(one.from, messages, found.effect, persists);
    });
    readDescriptors(descriptors, encoders);
  }
}
