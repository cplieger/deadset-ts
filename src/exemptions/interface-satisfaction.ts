/**
 * The interface-satisfaction class: a member is held back when a value of its class
 * reaches a position typed as an interface, or an object type a type alias names, that
 * requires the member: an `implements` entry, a typed initializer, an assignment, an
 * argument, a return, an array element, an object property or an `as` or `satisfies`
 * operand. `this` is a value of its class; a type parameter reaches its constraint. A
 * class installed as a global reaches the instance type the global constructs, whether
 * or not it is assignable to it, because a stub answers only what its caller uses. The
 * contextual lookup has no batch form, so it is asked only of a value of a target class.
 */

import {
  isCallExpression,
  isHeritageClause,
  isNewExpression,
  isTypeLiteralNode,
  SyntaxKind,
  type ClassLikeDeclaration,
  type Expression,
  type Node,
} from "@typescript/native/ast";
import { SymbolFlags, type Type } from "@typescript/native/sync";
import { aliasChains } from "../alias-chain.ts";
import { emptyImplementation } from "../findings/implementations.ts";
import { installedGlobals } from "./installed-globals.ts";
import type { DetectorInput, Evidence } from "./lifecycle.ts";
import { renderPosition } from "../position.ts";
import { must } from "../query.ts";
import type { ProjectSites } from "./sites.ts";

/** One class the inventory holds, by its declaration. */
interface ClassAt {
  readonly id: string;
  /** The name node, whose type is the class's instance type. */
  readonly name: Node;
  /** Whether the class declares type parameters, so its values carry instantiations of it. */
  readonly generic: boolean;
  readonly node: ClassLikeDeclaration;
}

/** One value that flows into a position the checker types from its context. */
interface Flow {
  readonly value: Expression;
  /** The class `this` stands for, where the value is `this`. */
  readonly self: ClassAt | undefined;
}

/** One entry of a class's `implements` clause. */
interface Clause {
  readonly owner: ClassAt;
  readonly entry: Node;
}

/** A class member answering an interface member: its declarations, and whether it is empty. */
interface Answering {
  readonly ids: readonly string[];
  readonly empty: boolean;
}

/** One class type reaching one interface type, and the places it does. */
interface Pair {
  readonly owner: ClassAt;
  readonly source: Type;
  readonly target: Type;
  readonly name: string;
  readonly sites: Node[];
  /** The global the class is installed as, which holds the members without assignability. */
  installed?: string;
}

/** Whether a type alias names one type: the client's type object carries the alias it was written through. */
function aliased(type: Type): boolean {
  return (type as { readonly aliasSymbol?: unknown }).aliasSymbol !== undefined;
}

/** What one project's sites hold that this class reads. */
interface Walked {
  readonly classes: readonly ClassAt[];
  readonly clauses: readonly Clause[];
  readonly flows: readonly Flow[];
}

/**
 * The named classes, the `implements` entries and the flowing values of one project's own
 * files, a value `this` standing for the class it is an instance of.
 */
function walked(sites: ProjectSites): Walked {
  const classes = sites.classes.flatMap(({ id, node }) =>
    node.name === undefined
      ? []
      : [{ id, name: node.name, generic: node.typeParameters !== undefined, node }],
  );
  const byId = new Map(classes.map((owner) => [owner.id, owner]));
  return {
    classes,
    clauses: classes.flatMap((owner) =>
      (owner.node.heritageClauses ?? []).flatMap((clause) =>
        isHeritageClause(clause) && clause.token === SyntaxKind.ImplementsKeyword
          ? clause.types.map((entry) => ({ owner, entry }))
          : [],
      ),
    ),
    flows: sites.flows.map((flow) => ({
      value: flow.value,
      self: flow.self === undefined ? undefined : byId.get(flow.self),
    })),
  };
}

/**
 * The interface-satisfaction detector: for each class type that reaches an interface
 * type it is assignable to, the class's members whose names the interface's members
 * carry, each recorded at the place the value flows.
 */
export function interfaceSatisfaction<Brand>(input: DetectorInput<Brand>): readonly Evidence[] {
  const { project, held, targetRoot } = input;
  const queries = project.queries;
  const chains = aliasChains(project, held);
  const { classes, clauses, flows } = walked(input.sites);
  if (classes.length === 0) {
    return [];
  }

  // One list, so the batches are capped runs of the whole project rather than of a
  // file: a class's name, an `implements` entry and a value are each one question.
  const asked = [
    ...classes.map((owner) => owner.name),
    ...clauses.map((clause) => clause.entry),
    ...flows.filter((flow) => flow.self === undefined).map((flow) => flow.value),
  ];
  const typeAt = new Map<Node, Type>();
  queries.typesAt(asked).forEach((answer, index) => {
    const type = must(answer);
    const node = asked[index];
    if (type !== undefined && node !== undefined) {
      typeAt.set(node, type);
    }
  });

  const classOfType = new Map<number, ClassAt>();
  const instanceOf = new Map<string, Type>();
  for (const owner of classes) {
    const type = typeAt.get(owner.name);
    if (type !== undefined) {
      classOfType.set(type.id, owner);
      instanceOf.set(owner.id, type);
    }
  }
  const instantiates = classes.some((owner) => owner.generic);

  const constituents = new Map<number, readonly Type[]>();
  const partsOf = (type: Type): readonly Type[] => {
    if (!type.isUnionType() && !type.isIntersectionType()) {
      return [type];
    }
    let parts = constituents.get(type.id);
    if (parts === undefined) {
      parts = must(queries.constituents(type));
      constituents.set(type.id, parts);
    }
    return parts;
  };

  const targets = new Map<number, ClassAt | undefined>();
  /** The classes of the target one value's type is an instance of, with the instance type. */
  const classesOf = (type: Type): readonly { owner: ClassAt; type: Type }[] =>
    partsOf(type).flatMap((part) => {
      const direct = classOfType.get(part.id);
      if (direct !== undefined) {
        return [{ owner: direct, type: part }];
      }
      if (!instantiates || !part.isTypeReference()) {
        return [];
      }
      if (!targets.has(part.id)) {
        targets.set(part.id, classOfType.get(must(queries.targetOf(part)).id));
      }
      const generic = targets.get(part.id);
      return generic === undefined ? [] : [{ owner: generic, type: part }];
    });

  const interfaceNames = new Map<string, string | undefined>();
  /**
   * The interface types one position's type is or holds, each with the interface's name:
   * an interface, or an object type literal a type alias names, directly or as a
   * constituent of an intersection the alias names.
   */
  const interfacesOf = (type: Type): readonly { type: Type; name: string }[] =>
    partsOf(type).flatMap((part): readonly { type: Type; name: string }[] => {
      if (part.isTypeParameter()) {
        const constraint = must(queries.constraintOf(part));
        return constraint === undefined ? [] : interfacesOf(constraint);
      }
      const named = aliased(part) ? part : aliased(type) ? type : undefined;
      const key = `${String(part.id)}:${String(named?.id ?? "")}`;
      if (!interfaceNames.has(key)) {
        const symbol = part.isObjectType() ? must(queries.symbolOfType(part)) : undefined;
        const flags = symbol?.flags ?? 0;
        interfaceNames.set(
          key,
          (flags & SymbolFlags.Interface) !== 0
            ? symbol?.name
            : (flags & SymbolFlags.TypeLiteral) !== 0 &&
                named !== undefined &&
                symbol?.declarations.some((handle) => {
                  const node = project.declarationAt(handle)?.node;
                  return node !== undefined && isTypeLiteralNode(node);
                }) === true
              ? must(queries.typeToString(named))
              : undefined,
        );
      }
      const name = interfaceNames.get(key);
      return name === undefined ? [] : [{ type: part, name }];
    });

  /**
   * The type an argument's parameter declares in the generic signature a call
   * instantiates, which is a type parameter where the argument is a type argument's value:
   * the contextual type of such an argument is the instantiation, not the parameter.
   */
  const genericPosition = (value: Expression): Type | undefined => {
    const call = value.parent;
    if (!isCallExpression(call) && !isNewExpression(call)) {
      return undefined;
    }
    const at = (call.arguments ?? []).findIndex((argument) => argument === value);
    const resolved = at < 0 ? undefined : must(queries.resolvedSignature(call));
    const generic = resolved === undefined ? undefined : must(queries.genericOf(resolved));
    return generic === undefined ? undefined : must(queries.typeAtPosition(generic, at));
  };

  const pairs = new Map<string, Pair>();
  const reach = (owner: ClassAt, source: Type, target: Type, name: string, site: Node): Pair => {
    const key = `${String(source.id)}:${String(target.id)}`;
    let pair = pairs.get(key);
    if (pair === undefined) {
      pair = { owner, source, target, name, sites: [site] };
      pairs.set(key, pair);
    } else {
      pair.sites.push(site);
    }
    return pair;
  };

  for (const clause of clauses) {
    const source = instanceOf.get(clause.owner.id);
    const target = typeAt.get(clause.entry);
    if (source === undefined || target === undefined) {
      continue;
    }
    for (const reached of interfacesOf(target)) {
      reach(clause.owner, source, reached.type, reached.name, clause.entry);
    }
  }

  // The positions of every flow carrying a class are asked for at once.
  const carrying = flows.flatMap((flow) => {
    const self = flow.self === undefined ? undefined : instanceOf.get(flow.self.id);
    const valueType = typeAt.get(flow.value);
    const sources =
      flow.self !== undefined && self !== undefined
        ? [{ owner: flow.self, type: self }]
        : valueType === undefined
          ? []
          : classesOf(valueType);
    return sources.length === 0 ? [] : [{ flow, sources }];
  });
  const positions = queries.contextualTypes(carrying.map((one) => one.flow.value));
  carrying.forEach(({ flow, sources }, index) => {
    const position = must(positions[index]);
    for (const type of [position, genericPosition(flow.value)]) {
      for (const reached of type === undefined ? [] : interfacesOf(type)) {
        for (const source of sources) {
          reach(source.owner, source.type, reached.type, reached.name, flow.value);
        }
      }
    }
  });

  const byId = new Map(classes.map((owner) => [owner.id, owner]));
  for (const one of installedGlobals(project, held, chains, input.sites)) {
    const owner = byId.get(one.id);
    const source = instanceOf.get(one.id);
    if (owner === undefined || source === undefined) {
      continue;
    }
    for (const instance of one.instances) {
      reach(owner, source, instance, one.global, one.site).installed = one.global;
    }
  }

  const required = new Map<number, ReadonlyMap<string, readonly string[]>>();
  const members = new Map<string, ReadonlyMap<string, Answering>>();
  const found: Evidence[] = [];
  const asking = [...pairs.values()].filter((pair) => pair.installed === undefined);
  const assignable = new Set(
    queries
      .assignableEach(asking)
      .flatMap((answer, index) => (must(answer) ? [asking[index]] : [])),
  );
  for (const pair of pairs.values()) {
    if (pair.installed === undefined && !assignable.has(pair)) {
      continue;
    }
    let names = required.get(pair.target.id);
    if (names === undefined) {
      names = new Map(
        must(queries.propertiesOf(pair.target)).map((property) => [
          property.escapedName,
          chains.declarationsOf(property),
        ]),
      );
      required.set(pair.target.id, names);
    }
    let answering = members.get(pair.owner.id);
    if (answering === undefined) {
      const instance = instanceOf.get(pair.owner.id) ?? pair.source;
      answering = new Map(
        must(queries.propertiesOf(instance)).map((property) => [
          property.escapedName,
          {
            ids: chains.declarationsOf(property),
            empty: emptyImplementation(project, property),
          },
        ]),
      );
      members.set(pair.owner.id, answering);
    }
    const detail =
      pair.installed === undefined
        ? `satisfies ${pair.name}`
        : `installed as the global ${pair.installed}`;
    for (const [name, methods] of names) {
      const member = answering.get(name);
      for (const id of member?.ids ?? []) {
        for (const site of pair.sites) {
          found.push({
            id,
            detail,
            site: renderPosition(site.getSourceFile(), targetRoot, site.getStart()),
            implementing: { methods, empty: member?.empty ?? false },
          });
        }
      }
    }
  }
  return found;
}
