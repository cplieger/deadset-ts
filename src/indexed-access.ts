/**
 * The members an indexed-access type names. `T["a" | "b"]` reads the members `a` and `b`
 * of `T` as a property access by either name would. Where the index is a type parameter
 * a call fixes, the call names the members the literal type argument names, written or
 * inferred, which is read off the parameter the type parameter annotates whole. The type
 * query of a type-query alias is no reference.
 */

import {
  isArrowFunction,
  isCallExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isIndexedAccessTypeNode,
  isLiteralTypeNode,
  isMethodDeclaration,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isParenthesizedTypeNode,
  isPropertyAccessExpression,
  isStringLiteral,
  isTypeReferenceNode,
  isUnionTypeNode,
  SyntaxKind,
  type Node,
  type SourceFile,
  type TypeNode,
} from "@typescript/native/unstable/ast";
import type { Type } from "@typescript/native/unstable/sync";
import type { AliasChains } from "./alias-chain.ts";
import { nodeKey, type Inventory } from "./inventory.ts";
import { renderPosition } from "./position.ts";
import { UNANSWERED } from "./query.ts";
import type { Reference } from "./references.ts";
import type { ProjectView } from "./session.ts";
import { typeQueryAliases } from "./type-query-alias.ts";

/** A function whose signature declares type parameters, by the kinds of node that can. */
type Generic = Node & {
  readonly typeParameters?: readonly { readonly name: Node }[];
  readonly parameters: readonly { readonly name: Node; readonly type?: TypeNode }[];
};

function isGeneric(node: Node): node is Generic {
  return (
    (isFunctionDeclaration(node) ||
      isMethodDeclaration(node) ||
      isArrowFunction(node) ||
      isFunctionExpression(node)) &&
    (node as { readonly typeParameters?: readonly unknown[] }).typeParameters !== undefined
  );
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

/** One indexed-access type whose index is a type parameter its function declares. */
interface ByParameter {
  readonly object: TypeNode;
  /** The index of the parameter the type parameter annotates whole. */
  readonly parameter: number;
}

/** An indexed access to resolve: the object type, the names, and where the reference is made. */
interface Access {
  readonly file: SourceFile;
  readonly from: string;
  readonly at: Node;
  readonly object: TypeNode | Type;
  readonly names: readonly string[];
}

/**
 * The references the indexed-access types of one project's own files make to the members
 * they name, each made by the declaration that holds the type or the call, or by the file.
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
  const generics = new Map<string, ByParameter[]>();
  const calls: { file: SourceFile; from: string; call: Node; name: string }[] = [];
  const names = new Set<string>();

  for (const file of project.ownSourceFiles()) {
    const fileId = held.declarations.get(nodeKey(file, file));
    if (fileId === undefined) {
      continue;
    }
    const aliasTypes = new Set(typeQueryAliases(file).map((alias) => alias.type));
    const visit = (node: Node, from: string, enclosing: readonly Generic[]): void => {
      const own = held.declarations.get(nodeKey(file, node));
      const holder = own ?? from;
      const inside = isGeneric(node) ? [...enclosing, node] : enclosing;
      if (isIndexedAccessTypeNode(node) && !aliasTypes.has(node)) {
        const literal = literalNames(node.indexType);
        if (literal !== undefined) {
          accesses.push({ file, from: holder, at: node, object: node.objectType, names: literal });
        } else {
          parameterIndex(node, inside, file, generics, names);
        }
      }
      if (isCallExpression(node) || isNewExpression(node)) {
        const callee = node.expression;
        const name = isIdentifier(callee)
          ? callee.text
          : isPropertyAccessExpression(callee) && isIdentifier(callee.name)
            ? callee.name.text
            : undefined;
        if (name !== undefined) {
          calls.push({ file, from: holder, call: node, name });
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

  for (const { file, from, call, name } of calls) {
    if (!names.has(name)) {
      continue;
    }
    const resolved = queries.resolvedSignature(call);
    if (resolved === UNANSWERED || resolved?.declaration === undefined) {
      continue;
    }
    const declaration = project.declarationAt(resolved.declaration)?.node;
    const byParameter =
      declaration === undefined
        ? undefined
        : generics.get(nodeKey(declaration.getSourceFile(), declaration));
    if (byParameter === undefined) {
      continue;
    }
    for (const { object, parameter } of byParameter) {
      const fixed = queries.typeAtPosition(resolved, parameter);
      const literal =
        fixed === UNANSWERED ? undefined : literalTypeNames(fixed, (type) => partsOf(type));
      if (literal !== undefined) {
        accesses.push({ file, from, at: call, object, names: literal });
      }
    }
  }

  function partsOf(type: Type): readonly Type[] {
    const parts = queries.constituents(type);
    return parts === UNANSWERED ? [type] : parts;
  }

  const objectNodes = accesses.flatMap((one) => ("kind" in one.object ? [one.object] : []));
  const typeOf = new Map<Node, Type>();
  queries.typesAt(objectNodes).forEach((answer, index) => {
    const node = objectNodes[index];
    if (answer !== UNANSWERED && answer !== undefined && node !== undefined) {
      typeOf.set(node, answer);
    }
  });

  const found: Reference[] = [];
  for (const access of accesses) {
    const type = "kind" in access.object ? typeOf.get(access.object) : access.object;
    if (type === undefined) {
      continue;
    }
    const position = renderPosition(access.file, root, access.at.getStart());
    for (const part of partsOf(type)) {
      const properties = queries.propertiesOf(part);
      if (properties === UNANSWERED) {
        continue;
      }
      for (const property of properties) {
        if (!access.names.includes(property.escapedName)) {
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
 * Records an indexed-access type whose index names a type parameter of an enclosing
 * function that a parameter of that function is annotated with whole, so a call's
 * argument for that parameter fixes the index.
 */
function parameterIndex(
  node: Node & { readonly objectType: TypeNode; readonly indexType: TypeNode },
  enclosing: readonly Generic[],
  file: SourceFile,
  generics: Map<string, ByParameter[]>,
  names: Set<string>,
): void {
  const index = unwrappedType(node.indexType);
  if (!isTypeReferenceNode(index) || !isIdentifier(index.typeName)) {
    return;
  }
  const spelled = index.typeName.text;
  for (const generic of [...enclosing].reverse()) {
    const declares = (generic.typeParameters ?? []).some(
      (parameter) => isIdentifier(parameter.name) && parameter.name.text === spelled,
    );
    if (!declares) {
      continue;
    }
    const at = generic.parameters.findIndex((parameter) => {
      const type = parameter.type === undefined ? undefined : unwrappedType(parameter.type);
      return (
        type !== undefined &&
        isTypeReferenceNode(type) &&
        isIdentifier(type.typeName) &&
        type.typeName.text === spelled
      );
    });
    if (at >= 0) {
      const key = nodeKey(file, generic);
      generics.set(key, [...(generics.get(key) ?? []), { object: node.objectType, parameter: at }]);
      const name = calledName(generic);
      if (name !== undefined) {
        names.add(name);
      }
    }
    return;
  }
}

/** The name a call writes to call one generic function: its own, or its variable's. */
function calledName(generic: Generic): string | undefined {
  const own = (generic as { readonly name?: Node }).name;
  if (own !== undefined && isIdentifier(own)) {
    return own.text;
  }
  const parent = generic.parent as { readonly kind: SyntaxKind; readonly name?: Node };
  return parent.kind === SyntaxKind.VariableDeclaration &&
    parent.name !== undefined &&
    isIdentifier(parent.name)
    ? parent.name.text
    : undefined;
}
