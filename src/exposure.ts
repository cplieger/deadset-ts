/**
 * Which types of the target each of its declarations hands to code outside the package:
 * the types each declaration a reference from outside reaches names, as written or as the
 * checker reads it, as the precondition of `DS1501` in the Contract's kinds reads that
 * reach.
 */

import {
  SignatureKind,
  SymbolFlags,
  type NodeHandle,
  type Symbol as TSSymbol,
  type Type,
} from "@typescript/native/sync";
import {
  isArrowFunction,
  isAsExpression,
  isBindingElement,
  isCallSignatureDeclaration,
  isClassExpression,
  isConstructorTypeNode,
  isConstructSignatureDeclaration,
  isDecorator,
  isEnumMember,
  isFunctionExpression,
  isFunctionTypeNode,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isMethodSignatureDeclaration,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isPropertySignatureDeclaration,
  isSatisfiesExpression,
  isSetAccessorDeclaration,
  isSpreadAssignment,
  isTypeAssertion,
  isTypeReferenceNode,
  type Node,
  type SourceFile,
} from "@typescript/native/ast";
import { aliasChains } from "./alias-chain.ts";
import { OUTSIDE, type Graph } from "./liveness/graph.ts";
import { nodeKey, type Inventory, type InventorySymbol, type SymbolKind } from "./inventory.ts";
import { isAnswered, type Answer } from "./query.ts";
import { typeNamesOf } from "./roots/published-reach.ts";
import type { Handle, ProjectView } from "./session.ts";

/** The declarations whose values a reference holds without naming them. */
const TYPES: ReadonlySet<SymbolKind> = new Set<SymbolKind>(["class", "interface", "type", "enum"]);

/** The symbol flags of a type the source spells as a literal, whose members are its own. */
const LITERAL = SymbolFlags.TypeLiteral | SymbolFlags.ObjectLiteral;

/** The members a type's definition names other types through, where exported. */
const MEMBERS: ReadonlySet<SymbolKind> = new Set<SymbolKind>([
  "method",
  "class-member",
  "interface-method",
  "type-member",
]);

/** The declarations of a module or a namespace whose signature or type hands values on. */
const CARRYING: ReadonlySet<SymbolKind> = new Set<SymbolKind>(["function", "variable", ...TYPES]);

/** The containers whose own declarations a reference from outside can reach. */
const SCOPES: ReadonlySet<SymbolKind> = new Set<SymbolKind>(["file", "namespace"]);

/** What one project's declarations carry. */
export interface Carriers {
  /** Per declaration, the declarations of the target it carries, each once. */
  readonly named: ReadonlyMap<string, readonly string[]>;
  /** The declarations whose surface the checker left unread, which may carry any type. */
  readonly unread: ReadonlySet<string>;
}

/** What a project whose carriers no rule reads carries: nothing. */
export const NO_CARRIERS: Carriers = { named: new Map(), unread: new Set() };

/** Whether a member is named from outside its type: neither `private` nor a private name. */
function exportedMember(symbol: InventorySymbol): boolean {
  return symbol.visibility === "public" || symbol.visibility === "protected";
}

/**
 * The declarations of one project that carry values out: a function, a variable or a type
 * a module or a namespace declares, and an exported member of a class, an interface or a
 * type. Neither is filtered by its export: only a declaration the reach meets passes it
 * on, and an unexported type an exported function returns passes it to what it names.
 */
function carrying(held: Inventory): readonly InventorySymbol[] {
  const byId = new Map(held.symbols.map((symbol) => [symbol.id, symbol]));
  return held.symbols.filter((symbol) => {
    const parent = byId.get(symbol.parent);
    if (MEMBERS.has(symbol.kind)) {
      return parent !== undefined && TYPES.has(parent.kind) && exportedMember(symbol);
    }
    return CARRYING.has(symbol.kind) && parent !== undefined && SCOPES.has(parent.kind);
  });
}

/** The node a declaration's symbol is resolved at: its name, or itself where it has none. */
function nameNode(node: Node): Node {
  return (node as { readonly name?: Node }).name ?? node;
}

/** Whether a value expression is one whose type the declaration output prints as written. */
function printedAsWritten(node: Node): boolean {
  return (
    isParenthesizedExpression(node) ||
    isAsExpression(node) ||
    isTypeAssertion(node) ||
    isSatisfiesExpression(node) ||
    isObjectLiteralExpression(node) ||
    isArrowFunction(node) ||
    isFunctionExpression(node) ||
    isClassExpression(node)
  );
}

/** Whether a type node is the `const` of a const assertion, which names no type. */
function isConstName(node: Node): boolean {
  return isTypeReferenceNode(node) && isIdentifier(node.typeName) && node.typeName.text === "const";
}

/**
 * Whether the declaration output prints a type or a member it meets by this declaration's
 * written types: a function type's, a signature's, a member's, or an expression's that
 * {@link printedAsWritten} holds. A type literal or a mapped type it prints from the
 * checker's members, so only each member's own declaration is read.
 */
function reused(node: Node): boolean {
  return (
    isFunctionTypeNode(node) ||
    isConstructorTypeNode(node) ||
    isPropertySignatureDeclaration(node) ||
    isMethodSignatureDeclaration(node) ||
    isCallSignatureDeclaration(node) ||
    isConstructSignatureDeclaration(node) ||
    isPropertyAssignment(node) ||
    isPropertyDeclaration(node) ||
    isMethodDeclaration(node) ||
    isGetAccessorDeclaration(node) ||
    isSetAccessorDeclaration(node) ||
    printedAsWritten(node)
  );
}

/**
 * Whether the declaration output leaves out the types one node of a declaration writes.
 * It prints an initializer only where its declaration has no annotation, and then as the
 * checker types it, except through what {@link printedAsWritten} holds: an assertion's
 * type in place of its operand, a function's or a class's signatures, an object literal's
 * properties, and the operand of a `satisfies`. A decorator and an enum member's or a
 * binding element's initializer are not printed.
 */
function unprinted(node: Node): boolean {
  const parent = node.parent as Node | undefined;
  if (parent === undefined) {
    return false;
  }
  if (isDecorator(node)) {
    return true;
  }
  const held = parent as { readonly initializer?: Node; readonly type?: Node };
  if (held.initializer === node) {
    return (
      isEnumMember(parent) ||
      isBindingElement(parent) ||
      held.type !== undefined ||
      !printedAsWritten(node)
    );
  }
  if (isAsExpression(parent) || isTypeAssertion(parent)) {
    return isConstName(parent.type)
      ? node === parent.type || !printedAsWritten(node)
      : node === parent.expression;
  }
  if (isSatisfiesExpression(parent)) {
    return node === parent.type || !printedAsWritten(node);
  }
  if (isParenthesizedExpression(parent) || isSpreadAssignment(parent)) {
    return !printedAsWritten(node);
  }
  return false;
}

/**
 * The declarations of the target each declaration of one project carries: those it names
 * as written, and those its type names as the checker reads it, so an inferred result names
 * its type as an annotation does. The walk reads a type's constituents, type arguments,
 * alias arguments, `partsOf`, literal members and index signatures, and each signature's
 * parameters, result and `signaturePartsOf`. A type of the target ends the walk, since its
 * own definition is read as its own.
 */
export function carriersOf<Brand>(project: ProjectView<Brand>, held: Inventory): Carriers {
  const { queries } = project;
  const chains = aliasChains(project, held);
  const kinds = new Map(held.symbols.map((symbol) => [symbol.id, symbol.kind]));
  const parents = new Map(held.symbols.map((symbol) => [symbol.id, symbol.parent]));
  const wanted = new Set(carrying(held).map((symbol) => symbol.id));
  const declared: {
    readonly id: string;
    readonly handle: Handle<Brand>;
    readonly written: readonly Handle<Brand>[];
  }[] = [];
  // A nested carrier and any other member of a type are read on that member, not on the
  // declaration that holds it; a type parameter is part of its declaration.
  const readAloneIn =
    (file: SourceFile) =>
    (nested: Node): boolean => {
      const id = held.declarations.get(nodeKey(file, nested));
      const kind = id === undefined ? undefined : kinds.get(id);
      return (
        unprinted(nested) ||
        (id !== undefined &&
          kind !== "type-parameter" &&
          (wanted.has(id) || TYPES.has(kinds.get(parents.get(id) ?? "") ?? "file")))
      );
    };
  for (const file of project.ownSourceFiles()) {
    const readAlone = readAloneIn(file);
    const visit = (node: Node): void => {
      const id = held.declarations.get(nodeKey(file, node));
      if (id !== undefined && wanted.has(id)) {
        declared.push({
          id,
          handle: project.handle(nameNode(node)),
          written: typeNamesOf(node, readAlone).map((name) => project.handle(name)),
        });
      }
      node.forEachChild(visit);
    };
    file.forEachChild(visit);
  }

  const unread = new Set<string>();
  let reading = "";
  const answer = <T>(found: Answer<T>, otherwise: T): T => {
    if (isAnswered(found)) {
      return found;
    }
    unread.add(reading);
    return otherwise;
  };
  const typesOf = (symbol: TSSymbol): readonly string[] =>
    chains.declarationsOf(symbol).filter((id) => TYPES.has(kinds.get(id) ?? "file"));
  // The declaration output prints an anonymous type or a literal's member by its own
  // declaration's written types where it has them, which name an alias the checker erases,
  // so the walk of one declaration keeps the target's own declarations of those it meets.
  const own = project.ownPaths();
  let meeting = new Map<string, NodeHandle>();
  const meet = (symbol: TSSymbol): void => {
    for (const handle of symbol.declarations) {
      if (own.has(handle.path)) {
        meeting.set(`${handle.path}#${String(handle.index)}`, handle);
      }
    }
  };

  const signatures = (type: Type, into: Set<string>, seen: Set<number>): void => {
    for (const kind of [SignatureKind.Call, SignatureKind.Construct]) {
      for (const signature of answer(queries.signaturesOf(type, kind), [])) {
        signature.parameters.forEach((_parameter, index) => {
          walk(answer(queries.parameterType(signature, index), undefined), into, seen);
        });
        walk(answer(queries.returnTypeOf(signature), undefined), into, seen);
        for (const part of answer(queries.signaturePartsOf(signature), [])) {
          walk(part, into, seen);
        }
      }
    }
  };
  // The parts of a type that spell other types, not counting the type itself.
  const structure = (type: Type, into: Set<string>, seen: Set<number>): void => {
    for (const part of answer(queries.constituents(type), [])) {
      if (part.id !== type.id) {
        walk(part, into, seen);
      }
    }
    for (const argument of answer(queries.typeArguments(type), [])) {
      walk(argument, into, seen);
    }
    for (const part of answer(queries.partsOf(type), [])) {
      walk(part, into, seen);
    }
    const symbol = answer(queries.symbolOfType(type), undefined);
    if (symbol !== undefined && (symbol.flags & LITERAL) !== 0) {
      for (const property of answer(queries.propertiesOf(type), [])) {
        meet(property);
        walk(answer(queries.typeOfSymbol(property), undefined), into, seen);
      }
      for (const info of answer(queries.indexInfosOf(type), [])) {
        walk(info.valueType, into, seen);
      }
    }
    signatures(type, into, seen);
  };
  const walk = (type: Type | undefined, into: Set<string>, seen: Set<number>): void => {
    if (type === undefined || seen.has(type.id)) {
      return;
    }
    seen.add(type.id);
    const alias = answer(queries.aliasSymbolOf(type), undefined);
    if (alias !== undefined) {
      for (const id of typesOf(alias)) {
        into.add(id);
      }
      for (const argument of answer(queries.aliasArgumentsOf(type), [])) {
        walk(argument, into, seen);
      }
      if (typesOf(alias).length > 0) {
        return;
      }
    }
    const symbol = answer(queries.symbolOfType(type), undefined);
    const named = symbol === undefined ? [] : typesOf(symbol);
    if (named.length > 0) {
      for (const id of named) {
        into.add(id);
      }
      for (const argument of answer(queries.typeArguments(type), [])) {
        walk(argument, into, seen);
      }
      return;
    }
    if (symbol !== undefined) {
      meet(symbol);
    }
    structure(type, into, seen);
  };

  // What one declaration's checker type names, by its kind.
  const definition = (symbol: TSSymbol, kind: SymbolKind | undefined, into: Set<string>): void => {
    const seen = new Set<number>();
    // A class's or an interface's own definition: its properties are members, which carry
    // on their own, so only its bases, signatures and index signatures are read here.
    const own = (type: Type): void => {
      for (const info of answer(queries.indexInfosOf(type), [])) {
        walk(info.valueType, into, seen);
      }
      signatures(type, into, seen);
    };
    if (kind === "class" || kind === "interface") {
      const instance = answer(queries.declaredTypeOf(symbol), undefined);
      const statics =
        kind === "class" ? answer(queries.typeOfSymbol(symbol), undefined) : undefined;
      const sides = [instance, statics].filter((side) => side !== undefined);
      for (const side of sides) {
        seen.add(side.id);
      }
      for (const base of instance === undefined ? [] : answer(queries.baseTypes(instance), [])) {
        walk(base, into, seen);
      }
      sides.forEach(own);
    } else if (kind === "type") {
      const aliased = answer(queries.declaredTypeOf(symbol), undefined);
      if (aliased !== undefined) {
        seen.add(aliased.id);
        structure(aliased, into, seen);
      }
    } else if (kind !== "enum") {
      walk(answer(queries.typeOfSymbol(symbol), undefined), into, seen);
    }
  };

  const symbols = project.symbolsAt(declared.map((one) => one.handle));
  const spelled = project.symbolsAt(declared.flatMap((one) => one.written));
  const reached: { readonly id: string; readonly into: Set<string>; readonly met: NodeHandle[] }[] =
    [];
  const add = (answered: Answer<TSSymbol | undefined>, into: Set<string>): void => {
    const name = answer(answered, undefined);
    for (const target of name === undefined ? [] : chains.chainOf(name)) {
      if (TYPES.has(kinds.get(target.id) ?? "file")) {
        into.add(target.id);
      }
    }
  };
  let from = 0;
  declared.forEach(({ id, written }, index) => {
    reading = id;
    const into = new Set<string>();
    for (const answered of spelled.slice(from, from + written.length)) {
      add(answered, into);
    }
    from += written.length;
    meeting = new Map();
    const symbol = answer(symbols[index], undefined);
    if (symbol !== undefined) {
      definition(symbol, kinds.get(id), into);
    }
    reached.push({ id, into, met: [...meeting.values()] });
  });

  const namesAt = new Map<string, readonly Handle<Brand>[]>();
  const writtenAt = (handle: NodeHandle): readonly Handle<Brand>[] => {
    const key = `${handle.path}#${String(handle.index)}`;
    let names = namesAt.get(key);
    if (names === undefined) {
      const node = project.declarationAt(handle)?.node;
      names =
        node === undefined || !reused(node)
          ? []
          : typeNamesOf(node, readAloneIn(node.getSourceFile())).map((name) =>
              project.handle(name),
            );
      namesAt.set(key, names);
    }
    return names;
  };
  const metNames = reached.map((one) => one.met.flatMap(writtenAt));
  const metSpelled = project.symbolsAt(metNames.flat());
  const named = new Map<string, readonly string[]>();
  from = 0;
  reached.forEach(({ id, into }, index) => {
    reading = id;
    const count = metNames[index]?.length ?? 0;
    for (const answered of metSpelled.slice(from, from + count)) {
      add(answered, into);
    }
    from += count;
    into.delete(id);
    named.set(id, [...into]);
  });
  return { named, unread };
}

/**
 * The types whose values a reference from outside the package reaches through the
 * package's own declarations, or every type where such a reference reaches a declaration
 * whose surface the checker left unread. `outside` flags each declaration of the graph a
 * reference from outside names; each passes the reach on to what it carries, a type to
 * each member it exports, a namespace to each declaration it exports and a member to its
 * type, until no declaration joins.
 */
export function exposedTypes(
  graph: Graph,
  outside: readonly boolean[],
  carriers: Carriers | undefined,
): ReadonlySet<string> | "every" {
  const { symbols, parent } = graph;
  const members: number[][] = symbols.map(() => []);
  symbols.forEach((symbol, at) => {
    const container = parent[at] ?? OUTSIDE;
    const holder = symbols[container];
    if (
      holder !== undefined &&
      ((TYPES.has(holder.kind) && MEMBERS.has(symbol.kind) && exportedMember(symbol)) ||
        (holder.kind === "namespace" && symbol.exported))
    ) {
      members[container]?.push(at);
    }
  });
  const reached = symbols.map((_symbol, at) => outside[at] === true);
  const queue = reached.flatMap((one, at) => (one ? [at] : []));
  const join = (at: number): void => {
    if (at !== OUTSIDE && reached[at] !== true) {
      reached[at] = true;
      queue.push(at);
    }
  };
  for (let at = queue.pop(); at !== undefined; at = queue.pop()) {
    const symbol = symbols[at];
    if (symbol === undefined) {
      continue;
    }
    if (carriers?.unread.has(symbol.id) === true) {
      return "every";
    }
    for (const id of carriers?.named.get(symbol.id) ?? []) {
      join(graph.at(id));
    }
    for (const member of members[at] ?? []) {
      join(member);
    }
    if (MEMBERS.has(symbol.kind)) {
      join(parent[at] ?? OUTSIDE);
    }
  }
  return new Set(
    symbols.flatMap((symbol, at) =>
      reached[at] === true && TYPES.has(symbol.kind) ? [symbol.id] : [],
    ),
  );
}

/** Whether code outside the package holds values of a type through the package's declarations. */
export function exposes(exposed: ReadonlySet<string> | "every", symbol: InventorySymbol): boolean {
  return TYPES.has(symbol.kind) && (exposed === "every" || exposed.has(symbol.id));
}
