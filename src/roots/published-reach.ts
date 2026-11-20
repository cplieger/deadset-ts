/**
 * The published reach of a library: what a consumer outside the target can name, from the
 * files a published manifest entry or a bundle hands it and the declarations a release tag
 * marks, through the types each published declaration names.
 */

import {
  isArrowFunction,
  isAssertionExpression,
  isExportAssignment,
  isExpressionWithTypeArguments,
  isFunctionLikeDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isParenthesizedExpression,
  isPropertyAssignment,
  isReturnStatement,
  isSatisfiesExpression,
  isPropertyAccessExpression,
  isQualifiedName,
  isIntersectionTypeNode,
  isTypeQueryNode,
  isTypeReferenceNode,
  isPropertyDeclaration,
  isVariableDeclaration,
  isVariableStatement,
  SyntaxKind,
  type Expression,
  type FunctionLikeDeclaration,
  type IntersectionTypeNode,
  type Node,
  type ObjectLiteralExpression,
  type SourceFile,
} from "@typescript/native/ast";
import { objectLiteralOf } from "../unwrap.ts";
import { aliasChains } from "../alias-chain.ts";
import { isGlobalBlock } from "../augmentations.ts";
import { heldName, nodeKey, type Inventory, type InventorySymbol } from "../inventory.ts";
import { UNANSWERED } from "../query.ts";
import type { ProjectView } from "../session.ts";
import {
  SymbolFlags,
  TypeFlags,
  type Symbol as TSSymbol,
  type Type,
} from "@typescript/native/sync";

/** A release tag of a documentation comment: `@` and its name, between white space or the ends. */
const RELEASE_TAG = /(?:^|\s)@(?:public|beta|alpha)(?=\s|$)/u;

/**
 * Whether the documentation comment of the statement that starts at `start`, the last
 * `/** *\/` comment before it with only white space between the two, holds a release tag.
 */
function releaseTagIn(text: string, from: number, start: number): boolean {
  const leading = text.slice(from, start);
  const open = leading.lastIndexOf("/**");
  const close = open < 0 ? -1 : leading.indexOf("*/", open + 3);
  if (close < 0 || leading.slice(close + 2).trim() !== "") {
    return false;
  }
  return RELEASE_TAG.test(leading.slice(open + 3, close));
}

/** The exported top-level declarations of the program's files a release tag marks. */
export function releaseTagged(
  held: Inventory,
  files: { readonly byPath: ReadonlyMap<string, SourceFile> },
): readonly string[] {
  const exported = new Set(held.symbols.filter((symbol) => symbol.exported).map((one) => one.id));
  const found: string[] = [];
  for (const file of files.byPath.values()) {
    for (const statement of file.statements) {
      if (!releaseTagIn(file.text, statement.pos, statement.getStart())) {
        continue;
      }
      const nodes: readonly Node[] = isVariableStatement(statement)
        ? statement.declarationList.declarations
        : [statement];
      for (const node of nodes) {
        const id = held.declarations.get(nodeKey(file, node));
        if (id !== undefined && exported.has(id)) {
          found.push(id);
        }
      }
    }
  }
  return found;
}

/** The kinds of container whose export table, not its members' visibility, says what it publishes. */
const EXPORTING_CONTAINERS: ReadonlySet<string> = new Set(["file", "namespace"]);

/**
 * Every declaration a consumer of the library can name, a published file itself excluded:
 * what the published files export, with a namespace's exported members and any other
 * declaration's public and protected ones; a declaration a published one's type names; an
 * exported declaration a release tag marks; each declaration a `declare global` block holds
 * in a published file or one holding a published declaration; and, as `guessed`, each
 * declaration spelled as a type name the checker leaves unanswered.
 */
export function publishedAPI<Brand>(
  project: ProjectView<Brand>,
  published: readonly SourceFile[],
  exportsOf: ReadonlyMap<string, readonly string[]>,
  held: Inventory,
  byPath: ReadonlyMap<string, SourceFile>,
  tagged: readonly string[],
): { readonly ids: readonly string[]; readonly guessed: readonly string[] } {
  const byId = new Map(held.symbols.map((symbol) => [symbol.id, symbol]));
  const children = childrenOf(held);
  const files = new Set(held.symbols.filter((one) => one.kind === "file").map((one) => one.id));
  const blocks = held.symbols.filter((one) => isGlobalBlock(one, files));
  const fileOf = (id: string): string | undefined => {
    let at = byId.get(id);
    while (at !== undefined && at.kind !== "file") {
      at = byId.get(at.parent);
    }
    return at?.id;
  };
  const publishedFiles = published.flatMap(
    (file) => held.declarations.get(nodeKey(file, file)) ?? [],
  );
  const seeds = [...tagged, ...published.flatMap((file) => exportsOf.get(file.fileName) ?? [])];
  return reachedTypes(project, held, byPath, seeds, (reached, reach) => {
    const typed = new Set([...publishedFiles, ...[...reached].flatMap((id) => fileOf(id) ?? [])]);
    for (const block of blocks.filter((one) => typed.has(one.parent))) {
      reach(block.id);
      for (const member of children.get(block.id) ?? []) {
        if (member.kind !== "type-parameter") {
          reach(member.id);
        }
      }
    }
  });
}

/**
 * Every declaration a value of the `seeds` carries to code that holds it, the seeds
 * included and a file excluded: a namespace's or a file's exported members and any other
 * declaration's public and protected ones, but for those an object type intersected with
 * a primitive declares; a declaration one reached writes as a type outside such an object
 * type, or the compiler infers for it; and, as `guessed`, each declaration spelled as a
 * type name the checker leaves unanswered. `grow`, called each time the walk runs out, may
 * reach more, and the walk goes on while it does.
 */
export function reachedTypes<Brand>(
  project: ProjectView<Brand>,
  held: Inventory,
  byPath: ReadonlyMap<string, SourceFile>,
  seeds: readonly string[],
  grow?: (reached: ReadonlySet<string>, reach: (id: string) => void) => void,
): { readonly ids: readonly string[]; readonly guessed: readonly string[] } {
  const byId = new Map(held.symbols.map((symbol) => [symbol.id, symbol]));
  const children = childrenOf(held);
  const nodes = declarationNodes(held, byPath);
  const chains = aliasChains(project, held);
  const reached = new Set<string>();
  const entered = new Set<string>();
  const guessed = new Set<string>();
  const pending: string[] = [];
  const reach = (id: string): void => {
    const file = byId.get(id)?.kind === "file";
    if (!(file ? entered : reached).has(id)) {
      (file ? entered : reached).add(id);
      pending.push(id);
    }
  };
  // What a declaration's own syntax writes outside the object types it intersects with a
  // primitive, which only the type system sees, asked once per declaration that writes an
  // intersection.
  const typeOnly = new Map<string, readonly Node[]>();
  const keptIn = (id: string): ((node: Node) => boolean) => {
    let parts = typeOnly.get(id);
    if (parts === undefined) {
      const symbol = byId.get(id);
      parts =
        symbol === undefined || symbol.kind === "file"
          ? []
          : typeOnlyParts(project, nodes.intersectionsOf(symbol));
      typeOnly.set(id, parts);
    }
    const within = parts;
    return (node) =>
      !within.some(
        (part) =>
          part.getSourceFile() === node.getSourceFile() &&
          part.pos <= node.pos &&
          node.end <= part.end,
      );
  };
  for (const id of seeds) {
    reach(id);
  }
  const grown = (): boolean => {
    grow?.(reached, reach);
    return pending.length > 0;
  };
  do {
    while (pending.length > 0) {
      const round: string[] = [];
      for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
        round.push(next);
        const exporting = EXPORTING_CONTAINERS.has(byId.get(next)?.kind ?? "");
        const kept = keptIn(next);
        for (const member of children.get(next) ?? []) {
          const reachable = exporting
            ? member.exported
            : member.visibility !== "private" && member.visibility !== "private-name";
          if (member.kind !== "type-parameter" && reachable && nodes.nodesOf(member).every(kept)) {
            reach(member.id);
          }
        }
      }
      const named = round.flatMap((id) => {
        const symbol = byId.get(id);
        return symbol === undefined || symbol.kind === "file"
          ? []
          : nodes.typeNamesOf(symbol).filter(keptIn(id));
      });
      const inferred = inferredTypeSymbols(
        project,
        round.flatMap((id) => {
          const symbol = byId.get(id);
          return symbol === undefined ? [] : nodes.nodesOf(symbol);
        }),
      );
      for (const symbol of inferred.types) {
        for (const target of chains.chainOf(symbol)) {
          reach(target.id);
        }
      }
      for (const symbol of inferred.members) {
        for (const target of chains.chainOf(symbol)) {
          const member = byId.get(target.id);
          if (member?.visibility === "public" || member?.visibility === "protected") {
            reach(target.id);
          }
        }
      }
      project.symbolsAt(named.map((node) => project.handle(node))).forEach((symbol, index) => {
        if (symbol === UNANSWERED) {
          const node = named[index];
          for (const id of node === undefined ? [] : (held.byName.get(heldName(node)) ?? [])) {
            guessed.add(id);
            reach(id);
          }
        } else if (symbol !== undefined) {
          for (const target of chains.chainOf(symbol)) {
            reach(target.id);
          }
        }
      });
    }
  } while (grown());
  return { ids: [...reached], guessed: [...guessed] };
}

/**
 * The type names and the intersection types declarations of the inventory write, each file
 * walked once, when first asked.
 */
function declarationNodes(
  held: Inventory,
  byPath: ReadonlyMap<string, SourceFile>,
): {
  typeNamesOf(symbol: InventorySymbol): readonly Node[];
  intersectionsOf(symbol: InventorySymbol): readonly IntersectionTypeNode[];
  nodesOf(symbol: InventorySymbol): readonly Node[];
} {
  const walked = new Map<string, { byId: Map<string, Node[]>; nodes: Set<Node> }>();
  const nodesIn = (path: string): { byId: Map<string, Node[]>; nodes: Set<Node> } => {
    const known = walked.get(path);
    if (known !== undefined) {
      return known;
    }
    const found = { byId: new Map<string, Node[]>(), nodes: new Set<Node>() };
    const file = byPath.get(path);
    if (file !== undefined) {
      const visit = (node: Node): void => {
        const id = held.declarations.get(nodeKey(file, node));
        if (id !== undefined) {
          found.nodes.add(node);
          found.byId.set(id, [...(found.byId.get(id) ?? []), node]);
        }
        node.forEachChild(visit);
      };
      visit(file);
    }
    walked.set(path, found);
    return found;
  };
  return {
    typeNamesOf: (symbol) => {
      const { byId, nodes } = nodesIn(symbol.position.path);
      return (byId.get(symbol.id) ?? []).flatMap((declaration) =>
        typeNamesOf(declaration, (nested) => nodes.has(nested)),
      );
    },
    intersectionsOf: (symbol) => {
      const { byId, nodes } = nodesIn(symbol.position.path);
      const found: IntersectionTypeNode[] = [];
      for (const declaration of byId.get(symbol.id) ?? []) {
        eachOwnNode(
          declaration,
          (nested) => nodes.has(nested),
          (node) => {
            if (isIntersectionTypeNode(node)) {
              found.push(node);
            }
          },
        );
      }
      return found;
    },
    nodesOf: (symbol) => nodesIn(symbol.position.path).byId.get(symbol.id) ?? [],
  };
}

/** The symbols of an anonymous object type a literal or a type literal writes. */
const LITERAL_SYMBOLS = SymbolFlags.ObjectLiteral | SymbolFlags.TypeLiteral;

/**
 * Whether the constituents of an intersection hold a primitive, as a brand such as
 * `string & { readonly __brand: "Id" }` does: a value of it is that primitive at runtime,
 * so it carries the primitive's members and none of its object types' (references-ts.44).
 */
function brandsAPrimitive(parts: readonly Type[]): boolean {
  return parts.some((part) => (part.flags & TypeFlags.Primitive) !== 0);
}

/**
 * The constituents of a union or an intersection a value of it carries: each of `parts`,
 * but for a primitive intersected with object types, whose object types are type-only.
 */
function carriedParts(type: Type, parts: readonly Type[]): readonly Type[] {
  return type.isIntersectionType() && brandsAPrimitive(parts)
    ? parts.filter((part) => !part.isObjectType())
    : parts;
}

/**
 * The constituents of the intersections among `written` whose types are a primitive
 * intersected with object types, and whose own types are object types: only the type
 * system sees them, so no value carries a member they declare or a type they name. A
 * question the checker leaves unanswered makes nothing type-only.
 */
function typeOnlyParts<Brand>(
  project: ProjectView<Brand>,
  written: readonly IntersectionTypeNode[],
): readonly Node[] {
  if (written.length === 0) {
    return [];
  }
  const { queries } = project;
  const parts = written.flatMap((node) => [...node.types]);
  const asked = queries.typesAt([...written, ...parts]);
  const found: Node[] = [];
  let next = written.length;
  written.forEach((node, index) => {
    const own = asked.slice(next, next + node.types.length);
    next += node.types.length;
    const type = asked[index];
    if (type === UNANSWERED || type === undefined) {
      return;
    }
    // A union of literals or `boolean` intersected with an object type is distributed into
    // a union of intersections, one per literal.
    const intersections = type.isUnionType() ? queries.constituents(type) : [type];
    if (
      intersections === UNANSWERED ||
      !intersections.every((one) => {
        const constituents = one.isIntersectionType() ? queries.constituents(one) : UNANSWERED;
        return constituents !== UNANSWERED && brandsAPrimitive(constituents);
      })
    ) {
      return;
    }
    node.types.forEach((part, at) => {
      const one = own[at];
      if (one !== UNANSWERED && one?.isObjectType() === true) {
        found.push(part);
      }
    });
  });
  return found;
}

/** How deep the type arguments, constituents and literal property types of an inferred type are followed. */
const INFERRED_DEPTH = 4;

/**
 * The values one function body returns, each through the type assertions around it: the
 * value a caller receives carries the operand's type whatever type the assertion or the
 * signature names. A nested function's returns are its own.
 */
function returnedValues(body: Node): readonly Expression[] {
  const found: Expression[] = [];
  const add = (value: Expression): void => {
    for (let at: Expression | undefined = value; at !== undefined;) {
      found.push(at);
      at =
        isAssertionExpression(at) || isSatisfiesExpression(at) || isParenthesizedExpression(at)
          ? at.expression
          : undefined;
    }
  };
  if (!isFunctionLikeDeclaration(body.parent) || body.parent.body !== body) {
    return found;
  }
  if (isArrowFunction(body.parent) && body.kind !== SyntaxKind.Block) {
    add(body as Expression);
    return found;
  }
  const visit = (node: Node): void => {
    if (isFunctionLikeDeclaration(node)) {
      return;
    }
    if (isReturnStatement(node) && node.expression !== undefined) {
      add(node.expression);
    }
    node.forEachChild(visit);
  };
  body.forEachChild(visit);
  return found;
}

/** The object literal one returned value is, written there or as the initializer of a variable `body` declares. */
function returnedLiteral(value: Expression, body: Node): ObjectLiteralExpression | undefined {
  const written = objectLiteralOf(value);
  if (written !== undefined) {
    return written;
  }
  if (!isIdentifier(value)) {
    return undefined;
  }
  let found: ObjectLiteralExpression | undefined;
  const visit = (node: Node): void => {
    if (
      isVariableDeclaration(node) &&
      isIdentifier(node.name) &&
      node.name.text === value.text &&
      node.initializer !== undefined
    ) {
      found = objectLiteralOf(node.initializer) ?? found;
    }
    if (!isFunctionLikeDeclaration(node)) {
      node.forEachChild(visit);
    }
  };
  body.forEachChild(visit);
  return found;
}

/**
 * The values one function body returns, and those each method of an object literal it
 * returns returns, to a fixed depth: a caller holding the literal calls its methods, and
 * receives what they return.
 */
function returnedThroughLiterals(body: Node, depth = 0): readonly Expression[] {
  const values = returnedValues(body);
  if (depth >= INFERRED_DEPTH) {
    return values;
  }
  const found = [...values];
  for (const value of values) {
    for (const property of returnedLiteral(value, body)?.properties ?? []) {
      const fn = isMethodDeclaration(property)
        ? property
        : isPropertyAssignment(property) && isFunctionLikeDeclaration(property.initializer)
          ? property.initializer
          : undefined;
      if (fn?.body !== undefined) {
        found.push(...returnedThroughLiterals(fn.body, depth + 1));
      }
    }
  }
  return found;
}

/**
 * The function a declaration is or holds: its own, a variable's initializer or a default
 * export's expression inside its parentheses.
 */
function functionOf(node: Node): FunctionLikeDeclaration | undefined {
  let held: Node | undefined = isFunctionLikeDeclaration(node)
    ? node
    : isVariableDeclaration(node)
      ? node.initializer
      : isExportAssignment(node)
        ? node.expression
        : undefined;
  while (held !== undefined && isParenthesizedExpression(held)) {
    held = held.expression;
  }
  return held !== undefined && isFunctionLikeDeclaration(held) ? held : undefined;
}

/**
 * The declarations of the types the compiler infers where a declaration writes none, and
 * of the values a function returns: the type of a variable or a property with no
 * annotation or of a default export's expression, the result of a function or a method
 * with no result annotation, and the type of each value its body returns, each with the
 * types its type arguments, its union or intersection constituents and, for an object or
 * array literal's type, its properties name, to a fixed depth, so a class a literal holds
 * is reached by its constructor type; and as `members` the properties of each returned
 * value's type. A question the checker leaves unanswered names nothing.
 */
function inferredTypeSymbols<Brand>(
  project: ProjectView<Brand>,
  declarations: readonly Node[],
): { readonly types: readonly TSSymbol[]; readonly members: readonly TSSymbol[] } {
  const { queries } = project;
  const valued = declarations.flatMap((node): readonly Node[] => {
    if (isExportAssignment(node)) {
      return functionOf(node) === undefined ? [node.expression] : [];
    }
    return (isVariableDeclaration(node) || isPropertyDeclaration(node)) &&
      node.type === undefined &&
      !isFunctionLikeDeclaration(node.initializer ?? node)
      ? [node.name]
      : [];
  });
  const returned = declarations.flatMap((node) => {
    const signature = functionOf(node);
    return signature?.body === undefined ? [] : returnedThroughLiterals(signature.body);
  });
  const types: Type[] = [];
  const returnedTypes: Type[] = [];
  queries.typesAt([...valued, ...returned]).forEach((type, at) => {
    if (type !== UNANSWERED && type !== undefined) {
      (at < valued.length ? types : returnedTypes).push(type);
    }
  });
  types.push(...returnedTypes);
  for (const node of declarations) {
    const signature =
      isVariableDeclaration(node) && node.type !== undefined ? undefined : functionOf(node);
    if (signature === undefined || signature.type !== undefined || signature.body === undefined) {
      continue;
    }
    const typed = queries.signatureOf(signature);
    const result =
      typed === UNANSWERED || typed === undefined ? undefined : queries.returnTypeOf(typed);
    if (result !== UNANSWERED && result !== undefined) {
      types.push(result);
    }
  }
  const found = new Map<number, TSSymbol>();
  // Each type keeps the shallowest depth it was met at: a literal can meet a type at the
  // bound before a shallower path does, and that path must still follow its parts.
  const seen = new Map<Type, number>();
  const visit = (type: Type, depth: number): void => {
    if (depth > INFERRED_DEPTH || (seen.get(type) ?? INFERRED_DEPTH + 1) <= depth) {
      return;
    }
    seen.set(type, depth);
    const symbol = queries.symbolOfType(type);
    if (symbol !== UNANSWERED && symbol !== undefined) {
      found.set(symbol.id, symbol);
    }
    const parts = queries.constituents(type);
    const args = queries.typeArguments(type);
    for (const next of [
      ...(parts === UNANSWERED || (parts.length === 1 && parts[0] === type)
        ? []
        : carriedParts(type, parts)),
      ...(args === UNANSWERED ? [] : args),
      ...propertyTypes(type, symbol),
    ]) {
      visit(next, depth + 1);
    }
  };
  // An anonymous literal type has no declaration of its own to reach, so its properties'
  // types are read here; a named type's properties are its members, which the walk reaches.
  const propertyTypes = (type: Type, symbol: TSSymbol | undefined | typeof UNANSWERED): Type[] => {
    if (symbol === UNANSWERED || symbol === undefined || (symbol.flags & LITERAL_SYMBOLS) === 0) {
      return [];
    }
    const properties = queries.propertiesOf(type);
    if (properties === UNANSWERED) {
      return [];
    }
    return queries
      .typesOfSymbols(properties)
      .flatMap((one) => (one === UNANSWERED || one === undefined ? [] : [one]));
  };
  types.forEach((type) => {
    visit(type, 0);
  });
  // A returned value carries each property of its type, one an anonymous type declares or
  // an intersection merges included, which no type name reaches, but none of the object
  // types a primitive is intersected with, alone or as a union's constituent.
  const members = new Map<number, TSSymbol>();
  const brand = (one: Type): boolean => {
    const parts = one.isIntersectionType() ? queries.constituents(one) : UNANSWERED;
    return parts !== UNANSWERED && brandsAPrimitive(parts);
  };
  const carriedBy = (type: Type): readonly Type[] => {
    const asked = queries.constituents(type);
    const parts = asked === UNANSWERED ? [] : asked;
    if (brand(type)) {
      return carriedParts(type, parts);
    }
    return type.isUnionType() && parts.some(brand) ? parts.flatMap(carriedBy) : [type, ...parts];
  };
  for (const type of returnedTypes) {
    for (const one of carriedBy(type)) {
      const properties = queries.propertiesOf(one);
      for (const property of properties === UNANSWERED ? [] : properties) {
        members.set(property.id, property);
      }
    }
  }
  return { types: [...found.values()], members: [...members.values()] };
}

/**
 * Each node of one declaration's own syntax, the declaration's included: a function body is
 * not read, and neither is a declaration nested in this one that `readAlone` says is read
 * on its own.
 */
function eachOwnNode(
  declaration: Node,
  readAlone: (nested: Node) => boolean,
  visit: (node: Node) => void,
): void {
  const walk = (node: Node): void => {
    if (node !== declaration && readAlone(node)) {
      return;
    }
    visit(node);
    const body = isFunctionLikeDeclaration(node) ? node.body : undefined;
    node.forEachChild((child) => {
      if (child !== body) {
        walk(child);
      }
    });
  };
  walk(declaration);
}

/**
 * The names of types one declaration's own syntax writes, as {@link eachOwnNode} reads it:
 * in a type reference, a heritage clause or a type query.
 */
export function typeNamesOf(
  declaration: Node,
  readAlone: (nested: Node) => boolean,
): readonly Node[] {
  const found: Node[] = [];
  eachOwnNode(declaration, readAlone, (node) => {
    if (isTypeReferenceNode(node)) {
      found.push(isQualifiedName(node.typeName) ? node.typeName.right : node.typeName);
    } else if (isExpressionWithTypeArguments(node)) {
      found.push(
        isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression,
      );
    } else if (isTypeQueryNode(node)) {
      found.push(isQualifiedName(node.exprName) ? node.exprName.right : node.exprName);
    }
  });
  return found;
}

/** The members of one declaration, indexed by the container that holds them. */
function childrenOf(held: Inventory): ReadonlyMap<string, readonly InventorySymbol[]> {
  const byParent = new Map<string, InventorySymbol[]>();
  for (const symbol of held.symbols) {
    const siblings = byParent.get(symbol.parent);
    if (siblings === undefined) {
      byParent.set(symbol.parent, [symbol]);
    } else {
      siblings.push(symbol);
    }
  }
  return byParent;
}
