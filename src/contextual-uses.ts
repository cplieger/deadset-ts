/**
 * The uses contextual types make of the target's members, which no name node resolves to.
 * An object-literal property writes the member of its name on each constituent of the
 * literal's contextual type that declares one. A value reaching a position typed by another
 * object type reads each of its members that type declares, through array elements and
 * function parameters and results too; a class instance there is the
 * interface-satisfaction class's evidence instead.
 */

import {
  isComputedPropertyName,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isStringLiteral,
  type Expression,
  type Node,
  type ObjectLiteralExpression,
} from "@typescript/native/unstable/ast";
import { SignatureKind, type Type } from "@typescript/native/unstable/sync";
import type { AliasChains } from "./alias-chain.ts";
import type { Inventory, SymbolKind } from "./inventory.ts";
import { isAnswered, type PropertyTables } from "./query.ts";
import type { ProjectView } from "./session.ts";

/** The member kinds a contextual type writes and reads: data members and the members of object types. */
const MEMBER_KINDS: ReadonlySet<SymbolKind> = new Set(["type-member", "class-member"]);

/** One object literal a walk found, and the declaration it is written inside. */
export interface LiteralAt {
  readonly literal: ObjectLiteralExpression;
  readonly from: string;
}

/** One value handed to a position typed by its context, and the declaration it is written inside. */
export interface FlowAt {
  readonly value: Expression;
  readonly from: string;
}

/** One use the contextual types make: the node it is written at and the members it names. */
export interface ContextualUse {
  readonly at: Node;
  readonly from: string;
  readonly ids: readonly string[];
}

/** What the contextual types of one project's literals and values use, and what asking cost. */
export interface ContextualUses {
  /** Each literal property that writes a member, by the property's node. */
  readonly writes: readonly ContextualUse[];
  /** Each value whose members a position typed by another object type reads. */
  readonly reads: readonly ContextualUse[];
  /** The batched lookups: contextual types and value types, one per capped run. */
  readonly batches: number;
  /** The per-type lookups: each distinct type's constituents, properties and declaring symbol. */
  readonly lookups: number;
}

/** The name one literal property is written under, where the name is literal text. */
function propertyName(property: Node): { node: Node; text: string } | undefined {
  if (
    !isPropertyAssignment(property) &&
    !isShorthandPropertyAssignment(property) &&
    !isMethodDeclaration(property) &&
    !isGetAccessorDeclaration(property) &&
    !isSetAccessorDeclaration(property)
  ) {
    return undefined;
  }
  const name = property.name;
  if (isIdentifier(name) || isStringLiteral(name) || isNumericLiteral(name)) {
    return { node: name, text: name.text };
  }
  if (isComputedPropertyName(name)) {
    const key = name.expression;
    if (isStringLiteral(key) || isNumericLiteral(key) || isNoSubstitutionTemplateLiteral(key)) {
      return { node: name, text: key.text };
    }
  }
  return undefined;
}

/** The parameter and result types of one call signature, each where the checker answered. */
interface Called {
  readonly parameters: readonly (Type | undefined)[];
  readonly result: Type | undefined;
}

/** One object type a value is checked as, and the position's object types it is checked against. */
interface Checked {
  readonly source: Type;
  readonly targets: readonly Type[];
}

/** How many element and signature steps the structural walk takes below a value's own type. */
const MAX_DEPTH = 3;

/** One member of an object type, by the inventory's declarations and the checker's declaration handles. */
interface Member {
  readonly ids: readonly string[];
  readonly handles: ReadonlySet<string>;
}

/**
 * The contextual uses of one project's literals and values, asked in batches: one
 * contextual type per literal and per value whose type carries a member of the target,
 * one type per value, and each distinct type's properties once.
 */
export function contextualUses<Brand>(
  project: ProjectView<Brand>,
  held: Inventory,
  chains: AliasChains,
  literals: readonly LiteralAt[],
  flows: readonly FlowAt[],
  cap: number,
  properties: PropertyTables,
): ContextualUses {
  const queries = project.queries;
  const kinds = new Map(held.symbols.map((symbol) => [symbol.id, symbol.kind]));
  let batches = 0;
  let lookups = 0;
  const batchesOf = (count: number): number => Math.ceil(count / cap);

  const parts = new Map<number, readonly Type[]>();
  /** The object types one type is: itself, or its constituents at any depth. */
  const partsOf = (type: Type): readonly Type[] => {
    const known = parts.get(type.id);
    if (known !== undefined) {
      return known;
    }
    let found: readonly Type[] = [];
    if (type.isUnionType() || type.isIntersectionType()) {
      lookups += 1;
      const constituents = queries.constituents(type);
      found = isAnswered(constituents) ? constituents.flatMap(partsOf) : [];
    } else if (type.isObjectType()) {
      found = [type];
    }
    parts.set(type.id, found);
    return found;
  };

  const tables = new Map<number, ReadonlyMap<string, Member>>();
  /** The members one object type has, by name. */
  const membersOf = (type: Type): ReadonlyMap<string, Member> => {
    const known = tables.get(type.id);
    if (known !== undefined) {
      return known;
    }
    const table = new Map<string, Member>();
    const read = properties.of(type);
    lookups += read.asked ? 1 : 0;
    for (const property of isAnswered(read.properties) ? read.properties : []) {
      table.set(property.name, {
        ids: chains
          .declarationsOf(property)
          .filter((id) => MEMBER_KINDS.has(kinds.get(id) ?? "file")),
        handles: new Set(
          property.declarations.map((handle) => `${handle.path}#${String(handle.index)}`),
        ),
      });
    }
    tables.set(type.id, table);
    return table;
  };

  const writes: ContextualUse[] = [];
  batches += batchesOf(literals.length);
  const contexts = queries.contextualTypes(
    literals.map((one) => one.literal),
    cap,
  );
  literals.forEach(({ literal, from }, index) => {
    const context = contexts[index];
    if (context === undefined || !isAnswered(context)) {
      return;
    }
    const tablesOf = partsOf(context).map(membersOf);
    for (const property of literal.properties) {
      const name = propertyName(property);
      if (name === undefined) {
        continue;
      }
      const ids = [...new Set(tablesOf.flatMap((table) => table.get(name.text)?.ids ?? []))];
      if (ids.length > 0) {
        writes.push({ at: name.node, from, ids });
      }
    }
  });

  const carried = flows.filter((flow) => !isObjectLiteralExpression(flow.value));
  batches += batchesOf(carried.length);
  const types = queries.typesAt(
    carried.map((flow) => flow.value),
    cap,
  );
  /** The members a position may read structurally: those of object types, not of classes. */
  const readable = (member: Member): readonly string[] =>
    member.ids.filter((id) => kinds.get(id) === "type-member");
  const carries = (part: Type): boolean =>
    [...membersOf(part).values()].some((member) => readable(member).length > 0);

  const elements = new Map<number, Type | undefined>();
  /** The element type of an array type, read once per type. */
  const elementOf = (type: Type): Type | undefined => {
    if (elements.has(type.id)) {
      return elements.get(type.id);
    }
    lookups += 1;
    const isArray = queries.isArray(type);
    let element: Type | undefined;
    if (isAnswered(isArray) && isArray) {
      lookups += 1;
      const held = queries.typeArguments(type);
      element = isAnswered(held) ? held[0] : undefined;
    }
    elements.set(type.id, element);
    return element;
  };

  const calls = new Map<number, Called | undefined>();
  /** The parameter and return types of a type's one call signature, read once per type. */
  const callOf = (type: Type): Called | undefined => {
    if (calls.has(type.id)) {
      return calls.get(type.id);
    }
    lookups += 1;
    const signatures = queries.signaturesOf(type, SignatureKind.Call);
    let called: Called | undefined;
    const [signature, ...more] = isAnswered(signatures) ? signatures : [];
    if (signature !== undefined && more.length === 0) {
      const parameters = signature.parameters.map((_parameter, index) =>
        queries.parameterType(signature, index),
      );
      const result = queries.returnTypeOf(signature);
      lookups += parameters.length + 1;
      called = {
        parameters: parameters.map((one) => (isAnswered(one) ? one : undefined)),
        result: isAnswered(result) ? result : undefined,
      };
    }
    calls.set(type.id, called);
    return called;
  };

  /**
   * Each object type a value of `source` is checked as against the object types of
   * `target`: the value's own, and through array elements and through a function's
   * parameters, checked the other way, and its result. A source that is one of the
   * target's own object types matches it as it stands.
   */
  const compared = (
    source: Type | undefined,
    target: Type | undefined,
    depth: number,
    into: Checked[],
    seen: Set<string>,
  ): void => {
    const key = `${String(source?.id)}>${String(target?.id)}`;
    if (source === undefined || target === undefined || source.id === target.id) {
      return;
    }
    if (depth > MAX_DEPTH || seen.has(key)) {
      return;
    }
    seen.add(key);
    const targets = partsOf(target);
    const sources = partsOf(source).filter((one) => !targets.some((part) => part.id === one.id));
    for (const one of sources) {
      if (carries(one)) {
        into.push({ source: one, targets });
      }
      const element = elementOf(one);
      const called = element === undefined ? callOf(one) : undefined;
      for (const part of targets) {
        if (element !== undefined) {
          compared(element, elementOf(part), depth + 1, into, seen);
          continue;
        }
        const other = called === undefined ? undefined : callOf(part);
        if (called === undefined || other === undefined) {
          continue;
        }
        other.parameters.forEach((parameter, index) => {
          compared(parameter, called.parameters[index], depth + 1, into, seen);
        });
        compared(called.result, other.result, depth + 1, into, seen);
      }
    }
  };

  /** Whether a value of one type may carry a member a position reads, at any depth the walk takes. */
  const mayCarry = (type: Type, depth: number): boolean =>
    depth <= MAX_DEPTH &&
    partsOf(type).some((part) => {
      if (carries(part)) {
        return true;
      }
      const element = elementOf(part);
      if (element !== undefined) {
        return mayCarry(element, depth + 1);
      }
      return callOf(part) !== undefined;
    });

  const sourced = carried.flatMap((flow, index) => {
    const type = types[index];
    return type === undefined || !isAnswered(type) || !mayCarry(type, 0) ? [] : [{ flow, type }];
  });
  batches += batchesOf(sourced.length);
  const positions = queries.contextualTypes(
    sourced.map((one) => one.flow.value),
    cap,
  );
  const reads: ContextualUse[] = [];
  sourced.forEach(({ flow, type }, index) => {
    const position = positions[index];
    if (position === undefined || !isAnswered(position)) {
      return;
    }
    const checked: Checked[] = [];
    compared(type, position, 0, checked, new Set());
    const ids = new Set<string>();
    for (const { source, targets } of checked) {
      const tables = targets.map(membersOf);
      for (const [name, member] of membersOf(source)) {
        const read = tables.some((table) => {
          const declared = table.get(name);
          return (
            declared !== undefined &&
            declared.handles.size > 0 &&
            ![...declared.handles].some((handle) => member.handles.has(handle))
          );
        });
        if (read) {
          for (const id of readable(member)) {
            ids.add(id);
          }
        }
      }
    }
    if (ids.size > 0) {
      reads.push({ at: flow.value, from: flow.from, ids: [...ids] });
    }
  });
  return { writes, reads, batches, lookups };
}
