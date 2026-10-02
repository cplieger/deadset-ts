/**
 * The enum-group class: every member of an `enum` declaration is held back when a value
 * of the enum arrives by conversion rather than by a member's name. The conversions are
 * a type assertion from a number or a string, an element access on the enum object
 * keyed by anything but literal text, and a decoded value typed as the enum: an `any`
 * or `unknown` expression asserted to it, or bound to a variable or returned from a
 * function it annotates, where a number counts too. An enum's own value converts nothing.
 */

import {
  isArrowFunction,
  isAsExpression,
  isElementAccessExpression,
  isEnumDeclaration,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNoSubstitutionTemplateLiteral,
  isParenthesizedExpression,
  isParenthesizedTypeNode,
  isPropertyAccessExpression,
  isReturnStatement,
  isStringLiteral,
  isVariableDeclaration,
  SyntaxKind,
  type Node,
  type SourceFile,
} from "@typescript/native/unstable/ast";
import { TypeFlags, type Type } from "@typescript/native/unstable/sync";
import { aliasChains } from "./alias-chain.ts";
import type { DetectorInput, Evidence } from "./exempt.ts";
import { nodeKey } from "./inventory.ts";
import { renderPosition } from "./position.ts";
import { DEFAULT_BATCH_CAP } from "./references.ts";

/** The operand types a conversion produces an enum value from. */
const NUMBER = TypeFlags.NumberLike;
const STRING = TypeFlags.StringLike;
const DECODED = TypeFlags.Any | TypeFlags.Unknown;

/** How one site produces a value of the type it names. */
type Form = "assertion" | "lookup" | "annotation";

/** One place that may produce a value of an enum. */
interface Site {
  readonly form: Form;
  /** The name node whose symbol says which declaration the site names. */
  readonly name: Node;
  /** The expression whose type decides the conversion, absent for a lookup. */
  readonly operand: Node | undefined;
  /** Where the evidence is recorded. */
  readonly at: Node;
}

/** The expression one node is, through however many parentheses are written around it. */
function unparenthesized(node: Node): Node {
  let held = node;
  while (isParenthesizedExpression(held)) {
    held = held.expression;
  }
  return held;
}

/**
 * The name node a type node names its declaration by: the identifier of a type
 * reference, the right side of a qualified one, through parentheses. A type that is no
 * reference names no declaration.
 */
function typeName(type: Node | undefined): Node | undefined {
  let held = type;
  while (held !== undefined && isParenthesizedTypeNode(held)) {
    held = held.type;
  }
  if (held?.kind !== SyntaxKind.TypeReference) {
    return undefined;
  }
  const name = (held as unknown as { readonly typeName: Node }).typeName;
  if (name.kind === SyntaxKind.QualifiedName) {
    return (name as unknown as { readonly right: Node }).right;
  }
  return name;
}

/** The name node an expression names an object by: an identifier, or a property access's name. */
function objectName(expression: Node): Node | undefined {
  const held = unparenthesized(expression);
  if (isIdentifier(held)) {
    return held;
  }
  return isPropertyAccessExpression(held) ? held.name : undefined;
}

/** The return type annotation of the function a return statement leaves, where it has one. */
function returnTypeOf(statement: Node): Node | undefined {
  for (let at = statement.parent; at.kind !== SyntaxKind.SourceFile; at = at.parent) {
    if (
      isFunctionDeclaration(at) ||
      isMethodDeclaration(at) ||
      isFunctionExpression(at) ||
      isArrowFunction(at) ||
      isGetAccessorDeclaration(at)
    ) {
      return at.type;
    }
  }
  return undefined;
}

/** Every site of one file that may produce a value of a type it names, in source order. */
function sitesOf(file: SourceFile): readonly Site[] {
  const found: Site[] = [];
  const annotated = (type: Node | undefined, value: Node | undefined, at: Node): void => {
    const name = typeName(type);
    if (name !== undefined && value !== undefined) {
      found.push({ form: "annotation", name, operand: value, at });
    }
  };
  const visit = (node: Node): void => {
    if (isAsExpression(node) || node.kind === SyntaxKind.TypeAssertionExpression) {
      const assertion = node as unknown as { readonly type: Node; readonly expression: Node };
      const name = typeName(assertion.type);
      if (name !== undefined) {
        found.push({ form: "assertion", name, operand: assertion.expression, at: node });
      }
    } else if (isElementAccessExpression(node)) {
      const key = node.argumentExpression;
      const name = objectName(node.expression);
      if (name !== undefined && !isStringLiteral(key) && !isNoSubstitutionTemplateLiteral(key)) {
        found.push({ form: "lookup", name, operand: undefined, at: node });
      }
    } else if (isVariableDeclaration(node)) {
      annotated(node.type, node.initializer, node.initializer ?? node);
    } else if (isReturnStatement(node) && node.expression !== undefined) {
      annotated(returnTypeOf(node), node.expression, node.expression);
    }
    node.forEachChild(visit);
  };
  file.forEachChild(visit);
  return found;
}

/**
 * The parts of one type that are not values of an enum: its constituents where it is a
 * union, and itself otherwise. An enum's own value, or one of its members, is a value the
 * source names, whichever number or string it also is.
 */
function partsOf(type: Type): readonly Type[] {
  const parts = type.isUnionType() ? type.getTypes() : [type];
  return parts.filter((part) => (part.flags & TypeFlags.EnumLike) === 0);
}

/**
 * The detail one site records about the enum it produces, or undefined where the
 * operand's type converts nothing: a number, or a string an assertion converts, is
 * converted, a value of type `any` or `unknown` is decoded, and a value of an enum is one
 * the source names.
 */
function detailOf(site: Site, enumName: string, operand: Type | undefined): string | undefined {
  if (site.form === "lookup") {
    return `looked up by an element access on ${enumName}`;
  }
  if (operand === undefined) {
    return undefined;
  }
  const parts = partsOf(operand);
  if (parts.some((part) => (part.flags & NUMBER) !== 0)) {
    return "converted from number";
  }
  if (parts.some((part) => (part.flags & STRING) !== 0)) {
    return site.form === "assertion" ? "converted from string" : undefined;
  }
  if (parts.some((part) => (part.flags & DECODED) !== 0)) {
    return `decoded as ${enumName}`;
  }
  return undefined;
}

/**
 * The enum-group detector: every member of each enum declaration of the target that a
 * conversion produces a value of, recorded at each conversion.
 */
export function enumGroup<Brand>(input: DetectorInput<Brand>): readonly Evidence[] {
  const { project, held, targetRoot } = input;
  const files = project.ownSourceFiles();

  // The enums of the target, by the identifier of their declaration, with their names.
  const enums = new Map<string, string>();
  for (const file of files) {
    const visit = (node: Node): void => {
      if (isEnumDeclaration(node)) {
        const id = held.declarations.get(nodeKey(file, node));
        if (id !== undefined) {
          enums.set(id, node.name.getText());
        }
      }
      node.forEachChild(visit);
    };
    file.forEachChild(visit);
  }
  if (enums.size === 0) {
    return [];
  }

  const sites = files.flatMap(sitesOf);
  const named = new Map<Site, string>();
  const chains = aliasChains(project, held);
  for (let from = 0; from < sites.length; from += DEFAULT_BATCH_CAP) {
    const run = sites.slice(from, from + DEFAULT_BATCH_CAP);
    project.symbolsAt(run.map((site) => project.handle(site.name))).forEach((symbol, index) => {
      const site = run[index];
      if (symbol === undefined || site === undefined) {
        return;
      }
      const target = chains.chainOf(symbol).find((link) => enums.has(link.id));
      if (target !== undefined) {
        named.set(site, target.id);
      }
    });
  }

  const typed = sites.filter((site) => named.has(site) && site.operand !== undefined);
  const operandType = new Map<Site, Type>();
  for (let from = 0; from < typed.length; from += DEFAULT_BATCH_CAP) {
    const run = typed.slice(from, from + DEFAULT_BATCH_CAP);
    project.checker
      .getTypeAtLocation(run.map((site) => site.operand ?? site.at))
      .forEach((type, index) => {
        const site = run[index];
        if (type !== undefined && site !== undefined) {
          operandType.set(site, type);
        }
      });
  }

  const members = new Map<string, string[]>();
  for (const symbol of held.symbols) {
    if (symbol.kind === "enum-member" && enums.has(symbol.parent)) {
      const listed = members.get(symbol.parent);
      if (listed === undefined) {
        members.set(symbol.parent, [symbol.id]);
      } else {
        listed.push(symbol.id);
      }
    }
  }

  const found: Evidence[] = [];
  for (const site of sites) {
    const enumId = named.get(site);
    if (enumId === undefined) {
      continue;
    }
    const detail = detailOf(site, enums.get(enumId) ?? "", operandType.get(site));
    if (detail === undefined) {
      continue;
    }
    const position = renderPosition(site.at.getSourceFile(), targetRoot, site.at.getStart());
    for (const id of members.get(enumId) ?? []) {
      found.push({ id, detail, site: position });
    }
  }
  return found;
}
