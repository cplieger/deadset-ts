/**
 * The interface-satisfaction class: a member is held back when a value of its class
 * reaches a position the checker types as an interface requiring that member, through an
 * `implements` entry, a typed initializer, an assignment, an argument, a return, an array
 * element, an object property or an `as` or `satisfies` operand. `this` is a value of its
 * class, and a position typed by a type parameter reaches its constraint. The contextual
 * lookup has no batch form, so it is asked only of a value typed as a target class.
 */

import {
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isClassStaticBlockDeclaration,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isHeritageClause,
  isMethodDeclaration,
  isNewExpression,
  isObjectLiteralExpression,
  isSetAccessorDeclaration,
  ModifierFlags,
  SyntaxKind,
  type Expression,
  type Node,
  type SourceFile,
} from "@typescript/native/unstable/ast";
import { SymbolFlags, type Type } from "@typescript/native/unstable/sync";
import { aliasChains } from "./alias-chain.ts";
import { emptyImplementation } from "./implementations.ts";
import type { DetectorInput, Evidence } from "./exempt.ts";
import type { Reference } from "./references.ts";
import type { Exemption } from "./sweep.ts";
import { nodeKey, type Inventory } from "./inventory.ts";
import { renderPosition } from "./position.ts";
import { must } from "./query.ts";
import { handedOn, valuesOf } from "./value-flow.ts";

/** One class the inventory holds, by its declaration. */
interface ClassAt {
  readonly id: string;
  /** The name node, whose type is the class's instance type. */
  readonly name: Node;
  /** Whether the class declares type parameters, so its values carry instantiations of it. */
  readonly generic: boolean;
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
}

/** Whether one node declares a static member, whose `this` is the class itself. */
function isStatic(node: Node): boolean {
  const flags = (node as { readonly modifierFlags?: number }).modifierFlags ?? 0;
  return (flags & ModifierFlags.Static) !== 0;
}

/** Whether one node is a method or an accessor of an object literal, whose `this` is the literal. */
function isObjectLiteralMethod(node: Node): boolean {
  return (
    (isMethodDeclaration(node) ||
      isGetAccessorDeclaration(node) ||
      isSetAccessorDeclaration(node)) &&
    isObjectLiteralExpression(node.parent)
  );
}

/** What one project's walk found to resolve. */
interface Walked {
  readonly classes: readonly ClassAt[];
  readonly clauses: readonly Clause[];
  readonly flows: readonly Flow[];
}

/**
 * The classes, the `implements` entries and the flowing values of one project's own
 * files. `this` is the class an instance member belongs to, so a function that is not
 * an arrow, a static member and a static block each stop it.
 */
function walk(files: readonly SourceFile[], declarations: ReadonlyMap<string, string>): Walked {
  const classes: ClassAt[] = [];
  const clauses: Clause[] = [];
  const flows: Flow[] = [];
  for (const file of files) {
    const visit = (node: Node, self: ClassAt | undefined): void => {
      let inner = self;
      if (isClassDeclaration(node) || isClassExpression(node)) {
        const id = declarations.get(nodeKey(file, node));
        const name = node.name;
        const owner =
          id === undefined || name === undefined
            ? undefined
            : { id, name, generic: node.typeParameters !== undefined };
        if (owner !== undefined) {
          classes.push(owner);
          for (const clause of node.heritageClauses ?? []) {
            if (isHeritageClause(clause) && clause.token === SyntaxKind.ImplementsKeyword) {
              clauses.push(...clause.types.map((entry) => ({ owner, entry })));
            }
          }
        }
        inner = owner;
      } else if (
        isFunctionDeclaration(node) ||
        isFunctionExpression(node) ||
        isClassStaticBlockDeclaration(node) ||
        isStatic(node) ||
        isObjectLiteralMethod(node)
      ) {
        inner = undefined;
      }
      for (const written of handedOn(node)) {
        for (const value of valuesOf(written)) {
          flows.push({
            value,
            self: value.kind === SyntaxKind.ThisKeyword ? inner : undefined,
          });
        }
      }
      node.forEachChild((child) => {
        visit(child, inner);
      });
    };
    file.forEachChild((child) => {
      visit(child, undefined);
    });
  }
  return { classes, clauses, flows };
}

/**
 * The interface-satisfaction detector: for each class type that reaches an interface
 * type it is assignable to, the class's members whose names the interface's members
 * carry, each recorded at the place the value flows.
 */
export function interfaceSatisfaction<Brand>(input: DetectorInput<Brand>): readonly Evidence[] {
  const { project, held, targetRoot } = input;
  const queries = project.queries;
  const files = project.ownSourceFiles();
  const { classes, clauses, flows } = walk(files, held.declarations);
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

  const interfaceNames = new Map<number, string | undefined>();
  /** The interface types one position's type is or holds, each with the interface's name. */
  const interfacesOf = (type: Type): readonly { type: Type; name: string }[] =>
    partsOf(type).flatMap((part): readonly { type: Type; name: string }[] => {
      if (part.isTypeParameter()) {
        const constraint = must(queries.constraintOf(part));
        return constraint === undefined ? [] : interfacesOf(constraint);
      }
      if (!interfaceNames.has(part.id)) {
        const symbol = part.isObjectType() ? must(queries.symbolOfType(part)) : undefined;
        interfaceNames.set(
          part.id,
          symbol !== undefined && (symbol.flags & SymbolFlags.Interface) !== 0
            ? symbol.name
            : undefined,
        );
      }
      const name = interfaceNames.get(part.id);
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
  const reach = (owner: ClassAt, source: Type, target: Type, name: string, site: Node): void => {
    const key = `${String(source.id)}:${String(target.id)}`;
    const pair = pairs.get(key);
    if (pair === undefined) {
      pairs.set(key, { owner, source, target, name, sites: [site] });
    } else {
      pair.sites.push(site);
    }
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

  const chains = aliasChains(project, held);
  const required = new Map<number, ReadonlyMap<string, readonly string[]>>();
  const members = new Map<string, ReadonlyMap<string, Answering>>();
  const found: Evidence[] = [];
  const asking = [...pairs.values()];
  const assignable = queries.assignableEach(asking);
  for (const [index, pair] of asking.entries()) {
    if (!must(assignable[index] ?? false)) {
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
    const detail = `satisfies ${pair.name}`;
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

/** One project's interface-satisfaction records settled against the run's calls. */
interface Settled {
  readonly evidence: readonly Exemption[];
  /** A reference from each uncalled interface method to each implementation it alone keeps. */
  readonly references: readonly Reference[];
}

/**
 * Each project's records with every record dropped whose member implements only interface
 * methods nothing calls, unless every implementation of such a method is empty, and a
 * reference from each such method to the member, which then falls with the method.
 * `references` is every reference of the run, a consumer's included.
 */
export function settledSatisfaction(
  projects: readonly { readonly evidence: readonly Exemption[]; readonly held: Inventory }[],
  references: readonly Reference[],
): readonly Settled[] {
  const methods = new Set(
    projects.flatMap((one) =>
      one.held.symbols.filter((symbol) => symbol.kind === "interface-method").map((one) => one.id),
    ),
  );
  const called = new Set(references.map((reference) => reference.to));
  const bodies = new Map<string, boolean>();
  for (const record of projects.flatMap((one) => one.evidence)) {
    for (const method of record.implementing?.methods ?? []) {
      bodies.set(method, (bodies.get(method) ?? true) && record.implementing?.empty === true);
    }
  }
  const uncalled = (method: string): boolean =>
    methods.has(method) && !called.has(method) && bodies.get(method) !== true;
  return projects.map(({ evidence }) => {
    const kept: Exemption[] = [];
    const added: Reference[] = [];
    for (const record of evidence) {
      const implemented = record.implementing?.methods ?? [];
      if (
        record.class !== "interface-satisfaction" ||
        implemented.length === 0 ||
        !implemented.every(uncalled)
      ) {
        kept.push(record);
        continue;
      }
      for (const method of implemented) {
        added.push({
          from: method,
          to: record.id,
          position: record.site,
          use: "read",
          resolution: "override",
          test: false,
        });
      }
    }
    return { evidence: kept, references: added };
  });
}
