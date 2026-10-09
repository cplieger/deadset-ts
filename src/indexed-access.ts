/**
 * The members an indexed-access type names: `T["a" | "b"]` reads `a` and `b` of `T`. An
 * index naming a type parameter is read once the reference or the call holding it fixes
 * that parameter, and a call of a method of a generic receiver fixes the receiver's by its
 * type arguments. The type query of a type-query alias is no reference.
 */

import {
  isArrowFunction,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isNonNullExpression,
  isParenthesizedExpression,
  isNamedImports,
  isNamespaceImport,
  isImportDeclaration,
  isIndexedAccessTypeNode,
  isInterfaceDeclaration,
  isLiteralTypeNode,
  isMethodDeclaration,
  isMethodSignatureDeclaration,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isParenthesizedTypeNode,
  isPropertyAccessExpression,
  isStringLiteral,
  isTypeAliasDeclaration,
  isTypeReferenceNode,
  isUnionTypeNode,
  isVariableDeclaration,
  type CallExpression,
  type NewExpression,
  type Node,
  type SourceFile,
  type TypeNode,
  type TypeReferenceNode,
} from "@typescript/native/unstable/ast";
import { SymbolFlags, type Symbol as TSSymbol, type Type } from "@typescript/native/unstable/sync";
import type { AliasChains } from "./alias-chain.ts";
import { nodeKey, type Inventory } from "./inventory.ts";
import { renderPosition } from "./position.ts";
import { UNANSWERED } from "./query.ts";
import type { Reference } from "./references.ts";
import type { ProjectView } from "./session.ts";
import { typeQueryAliases } from "./type-query-alias.ts";

/** A declaration that declares type parameters, by the kinds of node that can. */
type Generic = Node & {
  readonly typeParameters?: readonly { readonly name: Node }[];
  readonly parameters?: readonly { readonly name: Node; readonly type?: TypeNode }[];
};

function isGeneric(node: Node): node is Generic {
  return (
    (isFunctionDeclaration(node) ||
      isMethodDeclaration(node) ||
      isMethodSignatureDeclaration(node) ||
      isArrowFunction(node) ||
      isFunctionExpression(node) ||
      isTypeAliasDeclaration(node) ||
      isInterfaceDeclaration(node) ||
      isClassDeclaration(node) ||
      isClassExpression(node)) &&
    (node as { readonly typeParameters?: readonly unknown[] }).typeParameters !== undefined
  );
}

/** Whether one generic is a receiver's: a class or an interface whose methods it parameterizes. */
function isReceiver(node: Node): boolean {
  return isInterfaceDeclaration(node) || isClassDeclaration(node) || isClassExpression(node);
}

function unwrappedType(node: TypeNode): TypeNode {
  return isParenthesizedTypeNode(node) ? unwrappedType(node.type) : node;
}

/** The names a literal index type spells, or none where the index is any other type. */
function literalNames(index: TypeNode): readonly string[] | undefined {
  const node = unwrappedType(index);
  if (isUnionTypeNode(node)) {
    const names = node.types.map(literalNames);
    return names.every((one) => one !== undefined) ? names.flat() : undefined;
  }
  if (!isLiteralTypeNode(node)) {
    return undefined;
  }
  const literal = node.literal;
  if (isStringLiteral(literal) || isNoSubstitutionTemplateLiteral(literal)) {
    return [literal.text];
  }
  return isNumericLiteral(literal) ? [String(Number(literal.text))] : undefined;
}

/** The name a literal type carries, a union's each, or none where a constituent is no literal. */
function literalTypeNames(
  type: Type,
  parts: (type: Type) => readonly Type[],
): string[] | undefined {
  const names: string[] = [];
  for (const part of parts(type)) {
    if (part.isStringLiteralType()) {
      names.push(part.value);
    } else if (part.isNumberLiteralType()) {
      names.push(String(part.value));
    } else {
      return undefined;
    }
  }
  return names;
}

/**
 * One side of an indexed access inside a generic, as a site of the generic fixes it: the
 * type parameter of that position, a type the generic writes, or a type parameter of the
 * receiver whose method the generic is.
 */
type Side =
  | { readonly kind: "parameter"; readonly index: number }
  | { readonly kind: "written"; readonly node: TypeNode }
  | { readonly kind: "receiver"; readonly index: number };

/** An indexed access inside one generic whose index names a type parameter. */
interface Carried {
  readonly object: Side;
  readonly index: Side;
}

/** A side a site has fixed: a type node it writes, a type the compiler answers, or a type parameter it passes on. */
type Fixed =
  | { readonly kind: "node"; readonly node: TypeNode }
  | { readonly kind: "type"; readonly type: Type }
  | { readonly kind: "passed"; readonly generic: Generic; readonly index: number };

/** An indexed access to resolve: the object type, the index, and where the reference is made. */
interface Access {
  readonly file: SourceFile;
  readonly from: string;
  readonly at: Node;
  readonly object: TypeNode | Type;
  /** The names a literal index spells, or the index to read as a type. */
  readonly index: readonly string[] | TypeNode | Type;
}

/** A reference or a call that may fix a generic's type parameters. */
interface Site {
  readonly file: SourceFile;
  readonly from: string;
  readonly node: TypeReferenceNode | CallExpression | NewExpression;
  readonly name: string;
  readonly enclosing: readonly Generic[];
}

/** The type a fixed side stands for, or none where the site passes it on. */
function concrete(fixed: Fixed): TypeNode | Type | undefined {
  return fixed.kind === "node" ? fixed.node : fixed.kind === "type" ? fixed.type : undefined;
}

/** The position of the type parameter `name` among the ones a generic declares, or -1. */
function parameterAt(generic: Generic, name: string): number {
  return (generic.typeParameters ?? []).findIndex(
    (parameter) => isIdentifier(parameter.name) && parameter.name.text === name,
  );
}

/** The type parameter one type node names whole, among the enclosing generics, innermost first. */
function namedParameter(
  node: TypeNode,
  enclosing: readonly Generic[],
): { readonly generic: Generic; readonly index: number } | undefined {
  const type = unwrappedType(node);
  if (
    !isTypeReferenceNode(type) ||
    !isIdentifier(type.typeName) ||
    type.typeArguments !== undefined
  ) {
    return undefined;
  }
  const spelled = type.typeName.text;
  for (const generic of [...enclosing].reverse()) {
    const index = parameterAt(generic, spelled);
    if (index >= 0) {
      return { generic, index };
    }
  }
  return undefined;
}

/** The name a site writes to reach one generic: its own, or its variable's. */
function calledName(generic: Generic): string | undefined {
  const own = (generic as { readonly name?: Node }).name;
  if (own !== undefined && isIdentifier(own)) {
    return own.text;
  }
  const parent = generic.parent as Node | undefined;
  return parent !== undefined && isVariableDeclaration(parent) && isIdentifier(parent.name)
    ? parent.name.text
    : undefined;
}

/** The generic a declaration a symbol names is: the function a variable is initialized with included. */
function genericOf(node: Node): Generic | undefined {
  if (isGeneric(node)) {
    return node;
  }
  if (
    isVariableDeclaration(node) &&
    node.initializer !== undefined &&
    isGeneric(node.initializer)
  ) {
    return node.initializer;
  }
  return undefined;
}

/**
 * Each indexed access inside one generic whose index names a type parameter of it, read
 * from its own text: the object side is a type parameter of the same generic, one of the
 * receiver it is a method of, or a type it writes.
 */
function carriedIn(generic: Generic): readonly Carried[] {
  const found: Carried[] = [];
  const receiver = generic.parent as Node | undefined;
  const outer =
    receiver !== undefined && isReceiver(receiver) && isGeneric(receiver) ? receiver : undefined;
  const visit = (node: Node): void => {
    if (isIndexedAccessTypeNode(node)) {
      const index = namedParameter(node.indexType, [generic]);
      if (index !== undefined) {
        const own = namedParameter(node.objectType, [generic]);
        const fromReceiver =
          own === undefined && outer !== undefined
            ? namedParameter(node.objectType, [outer])
            : undefined;
        const object: Side =
          own !== undefined
            ? { kind: "parameter", index: own.index }
            : fromReceiver !== undefined
              ? { kind: "receiver", index: fromReceiver.index }
              : { kind: "written", node: node.objectType };
        found.push({ object, index: { kind: "parameter", index: index.index } });
      }
    }
    if (node !== generic && isGeneric(node)) {
      return;
    }
    node.forEachChild(visit);
  };
  visit(generic);
  return found;
}

/**
 * The references the indexed-access types of one project's own files make to the members
 * they name, each made by the declaration that holds the type, the reference or the call,
 * or by the file.
 */
export function indexedAccessReferences<Brand>(
  project: ProjectView<Brand>,
  held: Inventory,
  chains: AliasChains,
  root: string,
  testFiles: ReadonlySet<string>,
): readonly Reference[] {
  const queries = project.queries;
  const accesses: Access[] = [];
  const carried = new Map<Generic, Carried[]>();
  const names = new Set<string>();
  const sites: Site[] = [];
  /** Calls passing a literal argument whose callee a package binding heads, which a dependency's generic may fix. */
  const literalCalls: Site[] = [];

  const carry = (generic: Generic, one: Carried): boolean => {
    const known = carried.get(generic) ?? [];
    const same = known.some(
      (other) => JSON.stringify(sideKey(other)) === JSON.stringify(sideKey(one)),
    );
    if (same) {
      return false;
    }
    carried.set(generic, [...known, one]);
    const name = calledName(generic);
    if (name !== undefined) {
      names.add(name);
    }
    return true;
  };

  for (const file of project.ownSourceFiles()) {
    const fileId = held.declarations.get(nodeKey(file, file));
    if (fileId === undefined) {
      continue;
    }
    const aliasTypes = new Set(typeQueryAliases(file).map((alias) => alias.type));
    const imported = packageBindings(file);
    const visit = (node: Node, from: string, enclosing: readonly Generic[]): void => {
      const own = held.declarations.get(nodeKey(file, node));
      const holder = own ?? from;
      const inside = isGeneric(node) ? [...enclosing, node] : enclosing;
      if (isGeneric(node)) {
        carriedIn(node).forEach((one) => carry(node, one));
      }
      if (isIndexedAccessTypeNode(node) && !aliasTypes.has(node)) {
        const literal = literalNames(node.indexType);
        if (literal !== undefined) {
          accesses.push({ file, from: holder, at: node, object: node.objectType, index: literal });
        }
      }
      if (
        isTypeReferenceNode(node) &&
        node.typeArguments !== undefined &&
        isIdentifier(node.typeName)
      ) {
        sites.push({ file, from: holder, node, name: node.typeName.text, enclosing: inside });
      }
      if (isCallExpression(node) || isNewExpression(node)) {
        const callee = node.expression;
        const name = isIdentifier(callee)
          ? callee.text
          : isPropertyAccessExpression(callee) && isIdentifier(callee.name)
            ? callee.name.text
            : undefined;
        if (name !== undefined) {
          const site = { file, from: holder, node, name, enclosing: inside };
          sites.push(site);
          const literal = (node.arguments ?? []).some(
            (argument) => isStringLiteral(argument) || isNumericLiteral(argument),
          );
          const head = rootName(callee);
          if (literal && isCallExpression(node) && head !== undefined && imported.has(head)) {
            literalCalls.push(site);
          }
        }
      }
      node.forEachChild((child) => {
        visit(child, holder, inside);
      });
    };
    file.forEachChild((child) => {
      visit(child, fileId, []);
    });
  }

  function partsOf(type: Type): readonly Type[] {
    const parts = queries.constituents(type);
    return parts === UNANSWERED ? [type] : parts;
  }

  /** The generics one symbol declares, through the alias it may be. */
  const genericsOf = (symbol: TSSymbol): readonly Generic[] => {
    const target = (symbol.flags & SymbolFlags.Alias) === 0 ? symbol : queries.aliased(symbol);
    if (target === UNANSWERED) {
      return [];
    }
    return target.declarations.flatMap((handle) => {
      const node = project.declarationAt(handle)?.node;
      const generic = node === undefined ? undefined : genericOf(node);
      return generic === undefined ? [] : [generic];
    });
  };

  /** What one site fixes for one side of a carried access. */
  const fixedAt = (site: Site, side: Side, generic: Generic): Fixed | undefined => {
    if (side.kind === "written") {
      return { kind: "node", node: side.node };
    }
    const { node } = site;
    if (side.kind === "receiver") {
      const callee = isCallExpression(node) ? node.expression : undefined;
      if (callee === undefined || !isPropertyAccessExpression(callee)) {
        return undefined;
      }
      const receiver = queries.typeAt(callee.expression);
      if (receiver === UNANSWERED || receiver === undefined) {
        return undefined;
      }
      const args = queries.typeArguments(receiver);
      const type = args === UNANSWERED ? undefined : args[side.index];
      return type === undefined ? undefined : { kind: "type", type };
    }
    const written = node.typeArguments?.[side.index];
    if (written !== undefined) {
      const passed = namedParameter(written, site.enclosing);
      return passed === undefined
        ? { kind: "node", node: written }
        : { kind: "passed", generic: passed.generic, index: passed.index };
    }
    if (isTypeReferenceNode(node)) {
      return undefined;
    }
    const at = (generic.parameters ?? []).findIndex((parameter) => {
      const type = parameter.type === undefined ? undefined : unwrappedType(parameter.type);
      return (
        type !== undefined &&
        isTypeReferenceNode(type) &&
        isIdentifier(type.typeName) &&
        parameterAt(generic, type.typeName.text) === side.index
      );
    });
    if (at < 0) {
      return undefined;
    }
    const resolved = queries.resolvedSignature(node);
    if (resolved === UNANSWERED || resolved === undefined) {
      return undefined;
    }
    const type = queries.typeAtPosition(resolved, at);
    return type === UNANSWERED ? undefined : { kind: "type", type };
  };

  /** Reads one carried access at one site: an access where both sides are fixed, a carry where one is passed on. */
  const readAt = (site: Site, generic: Generic, one: Carried): boolean => {
    const object = fixedAt(site, one.object, generic);
    const index = object === undefined ? undefined : fixedAt(site, one.index, generic);
    if (object === undefined || index === undefined) {
      return false;
    }
    const passed = [object, index].find((fixed) => fixed.kind === "passed");
    if (passed !== undefined) {
      const side = (fixed: Fixed): Side | undefined =>
        fixed.kind === "passed"
          ? fixed.generic === passed.generic
            ? { kind: "parameter", index: fixed.index }
            : undefined
          : fixed.kind === "node"
            ? { kind: "written", node: fixed.node }
            : undefined;
      const objectSide = side(object);
      const indexSide = side(index);
      return objectSide !== undefined && indexSide !== undefined
        ? carry(passed.generic, { object: objectSide, index: indexSide })
        : false;
    }
    const objectAt = concrete(object);
    const indexAt = concrete(index);
    if (objectAt === undefined || indexAt === undefined) {
      return false;
    }
    accesses.push({
      file: site.file,
      from: site.from,
      at: site.node,
      object: objectAt,
      index: "kind" in indexAt ? (literalNames(indexAt) ?? indexAt) : indexAt,
    });
    return false;
  };

  // A site passing a type parameter on carries the access to its own generic, so the
  // sites are read again until no generic gains an access.
  const resolvedGenerics = new Map<Site, readonly Generic[]>();
  const read = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    const pending = sites.filter((site) => names.has(site.name) && !resolvedGenerics.has(site));
    const typeSites = pending.filter((site) => isTypeReferenceNode(site.node));
    const symbols =
      typeSites.length === 0
        ? []
        : queries.symbolsAt(typeSites.map((site) => (site.node as TypeReferenceNode).typeName));
    typeSites.forEach((site, at) => {
      const symbol = symbols[at];
      resolvedGenerics.set(
        site,
        symbol === UNANSWERED || symbol === undefined ? [] : genericsOf(symbol),
      );
    });
    for (const site of pending.filter((one) => !isTypeReferenceNode(one.node))) {
      const resolved = queries.resolvedSignature(site.node);
      const declaration =
        resolved === UNANSWERED || resolved?.declaration === undefined
          ? undefined
          : project.declarationAt(resolved.declaration)?.node;
      const generic = declaration === undefined ? undefined : genericOf(declaration);
      resolvedGenerics.set(site, generic === undefined ? [] : [generic]);
    }
    sites.forEach((site, siteAt) => {
      for (const generic of resolvedGenerics.get(site) ?? []) {
        (carried.get(generic) ?? []).forEach((one, at) => {
          const key = `${String(siteAt)}:${String(at)}:${nodeKey(generic.getSourceFile(), generic)}`;
          if (read.has(key)) {
            return;
          }
          read.add(key);
          changed = readAt(site, generic, one) || changed;
        });
      }
    });
  }

  // A generic function or method declared outside the project's own files carries what
  // its own text indexes by its type parameters and its receiver's.
  const outside = literalCalls.filter((site) => !resolvedGenerics.has(site));
  const methods =
    outside.length === 0
      ? []
      : queries.symbolsAt(
          outside.map((site) => {
            const callee = (site.node as CallExpression).expression;
            return isPropertyAccessExpression(callee) ? callee.name : callee;
          }),
        );
  const own = project.ownPaths();
  outside.forEach((site, at) => {
    const named = methods[at];
    const symbol =
      named === UNANSWERED || named === undefined || (named.flags & SymbolFlags.Alias) === 0
        ? named
        : queries.aliased(named);
    if (
      symbol === UNANSWERED ||
      symbol === undefined ||
      (symbol.flags & (SymbolFlags.Function | SymbolFlags.Method)) === 0
    ) {
      return;
    }
    for (const handle of symbol.declarations) {
      if (own.has(handle.path)) {
        continue;
      }
      const node = project.declarationAt(handle)?.node;
      const generic = node === undefined ? undefined : genericOf(node);
      if (generic === undefined) {
        continue;
      }
      for (const one of carriedIn(generic)) {
        readAt(site, generic, one);
      }
    }
  });

  const typeNodes = accesses.flatMap((one) => [
    ...("kind" in one.object ? [one.object] : []),
    ...(!Array.isArray(one.index) && "kind" in one.index ? [one.index] : []),
  ]);
  const typeOf = new Map<Node, Type>();
  queries.typesAt(typeNodes).forEach((answer, index) => {
    const node = typeNodes[index];
    if (answer !== UNANSWERED && answer !== undefined && node !== undefined) {
      typeOf.set(node, answer);
    }
  });
  const asType = (side: TypeNode | Type): Type | undefined =>
    "kind" in side ? typeOf.get(side) : side;

  const found: Reference[] = [];
  for (const access of accesses) {
    const type = asType(access.object);
    const indexType = Array.isArray(access.index)
      ? undefined
      : asType(access.index as TypeNode | Type);
    const accessed = Array.isArray(access.index)
      ? (access.index as readonly string[])
      : indexType === undefined
        ? undefined
        : literalTypeNames(indexType, partsOf);
    if (type === undefined || accessed === undefined) {
      continue;
    }
    const position = renderPosition(access.file, root, access.at.getStart());
    for (const part of partsOf(type)) {
      const properties = queries.propertiesOf(part);
      if (properties === UNANSWERED) {
        continue;
      }
      for (const property of properties) {
        if (!accessed.includes(property.escapedName)) {
          continue;
        }
        for (const to of chains.declarationsOf(property)) {
          found.push({
            from: access.from,
            to,
            position,
            use: "read",
            resolution: "batch",
            test: testFiles.has(position.path),
          });
        }
      }
    }
  }
  return found;
}

/**
 * The local names one file binds to a package: each name an import declaration with a
 * bare specifier binds, and each variable initialized by a call or a construction whose
 * callee such a name heads, read in source order.
 */
function packageBindings(file: SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  for (const statement of file.statements) {
    if (
      !isImportDeclaration(statement) ||
      !isStringLiteral(statement.moduleSpecifier) ||
      /^[./]/u.test(statement.moduleSpecifier.text)
    ) {
      continue;
    }
    const clause = statement.importClause;
    if (clause?.name !== undefined) {
      names.add(clause.name.text);
    }
    const bindings = clause?.namedBindings;
    if (bindings !== undefined && isNamespaceImport(bindings)) {
      names.add(bindings.name.text);
    } else if (bindings !== undefined && isNamedImports(bindings)) {
      bindings.elements.forEach((element) => names.add(element.name.text));
    }
  }
  if (names.size === 0) {
    return names;
  }
  const visit = (node: Node): void => {
    if (
      isVariableDeclaration(node) &&
      isIdentifier(node.name) &&
      node.initializer !== undefined &&
      (isCallExpression(node.initializer) || isNewExpression(node.initializer))
    ) {
      const head = rootName(node.initializer.expression);
      if (head !== undefined && names.has(head)) {
        names.add(node.name.text);
      }
    }
    node.forEachChild(visit);
  };
  visit(file);
  return names;
}

/** The identifier an expression is headed by, through property accesses and calls. */
function rootName(expression: Node): string | undefined {
  let at: Node = expression;
  for (;;) {
    if (isIdentifier(at)) {
      return at.text;
    }
    if (isPropertyAccessExpression(at) || isCallExpression(at) || isNewExpression(at)) {
      at = at.expression;
      continue;
    }
    if (isParenthesizedExpression(at) || isNonNullExpression(at)) {
      at = at.expression;
      continue;
    }
    return undefined;
  }
}

/** What makes two carried accesses one: the kind and position of each side, or its written node. */
function sideKey(one: Carried): readonly unknown[] {
  const key = (side: Side): unknown =>
    side.kind === "written" ? ["written", side.node.pos, side.node.end] : [side.kind, side.index];
  return [key(one.object), key(one.index)];
}
