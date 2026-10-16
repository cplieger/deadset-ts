/**
 * The injection-container class: a container constructs a class passed to a call
 * `ts.injection_registrations` names, or one a parameter of whose constructor carries a
 * decorator, passes every argument of its constructor, and populates each of its
 * properties and accessors that carries a decorator, a base class's included. So each
 * parameter property is injected, decorated or not. A constructor is no declaration of
 * the inventory, so the class stands for it and the registration referencing it keeps it.
 */

import {
  isClassDeclaration,
  isClassExpression,
  isConstructorDeclaration,
  isGetAccessorDeclaration,
  isPropertyDeclaration,
  isSetAccessorDeclaration,
  type CallExpression,
  type Decorator,
  type Node,
} from "@typescript/native/ast";
import { aliasChains } from "./alias-chain.ts";
import { calleeName, callsOf, classesPassed, decoratorsOf, spelledDecorator } from "./calls.ts";
import { classMembers, type ClassMember } from "./class-members.ts";
import {
  entriesAt,
  namesADeclaration,
  resolveEntries,
  spelledEntry,
  type ResolvedEntry,
} from "./configured-declarations.ts";
import type { DetectorInput, Evidence } from "./exempt.ts";
import { isParameterProperty, nodeKey } from "./inventory.ts";
import { renderPosition } from "./position.ts";

/** One class a container constructs, by the registration that says so. */
interface Registration {
  readonly id: string;
  readonly site: Node;
  readonly detail: string;
}

/** Whether one member declaration is a parameter property, or a property or accessor carrying a decorator. */
function isInjected(node: Node): boolean {
  return (
    isParameterProperty(node) ||
    ((isPropertyDeclaration(node) ||
      isGetAccessorDeclaration(node) ||
      isSetAccessorDeclaration(node)) &&
      decoratorsOf(node).length > 0)
  );
}

/** The classes of the target a call whose callee an entry names passes, with that call's entry. */
function registrations<Brand>(input: DetectorInput<Brand>): readonly Registration[] {
  const { project, held } = input;
  const resolved = resolveEntries(project, held, input.ts.injection_registrations);
  if (!resolved.some(namesADeclaration)) {
    return [];
  }
  const chains = aliasChains(project, held);
  const calls = callsOf(project);
  const named = entriesAt(
    project,
    chains,
    calls.flatMap((call) => calleeName(call.expression) ?? []),
    resolved,
  );
  const matched = new Map<CallExpression, ResolvedEntry>();
  for (const call of calls) {
    const name = calleeName(call.expression);
    const [entry] = name === undefined ? [] : (named.get(name) ?? []);
    if (entry !== undefined) {
      matched.set(call, entry);
    }
  }
  return [...classesPassed(project, held, chains, [...matched.keys()])].flatMap(([call, uses]) => {
    const entry = matched.get(call);
    const detail = entry === undefined ? "" : `registered by ${spelledEntry(entry.entry, held)}`;
    return uses.map((use) => ({ id: use.id, site: use.site, detail }));
  });
}

/**
 * The classes of the target a parameter of whose constructor carries a decorator, each
 * with the first such decorator.
 */
function constructedForParameters<Brand>(
  input: DetectorInput<Brand>,
): ReadonlyMap<string, Decorator> {
  const { project, held } = input;
  const found = new Map<string, Decorator>();
  for (const file of project.ownSourceFiles()) {
    const visit = (node: Node): void => {
      if (isClassDeclaration(node) || isClassExpression(node)) {
        const id = held.declarations.get(nodeKey(file, node));
        const [asks] = node.members.flatMap((member) =>
          isConstructorDeclaration(member) ? member.parameters.flatMap(decoratorsOf) : [],
        );
        if (id !== undefined && asks !== undefined) {
          found.set(id, asks);
        }
      }
      node.forEachChild(visit);
    };
    file.forEachChild(visit);
  }
  return found;
}

/**
 * The injection-container detector: each decorated property or accessor of a class a
 * container constructs, recorded at the registration that names the class, or, for a
 * class whose constructor asks for its parameters, at the member's own decorator.
 */
export function injectionContainer<Brand>(input: DetectorInput<Brand>): readonly Evidence[] {
  const { project, held, targetRoot } = input;
  const registered = registrations(input);
  const constructed = constructedForParameters(input);
  const classes = new Set([...registered.map((one) => one.id), ...constructed.keys()]);
  if (classes.size === 0) {
    return [];
  }
  const members = classMembers(project, held, classes, "instance");
  const injected = (id: string): readonly ClassMember[] =>
    (members.get(id) ?? []).filter((member) => isInjected(member.node));
  const at = (node: Node) => renderPosition(node.getSourceFile(), targetRoot, node.getStart());

  const found: Evidence[] = [];
  for (const registration of registered) {
    for (const member of injected(registration.id)) {
      found.push({ id: member.id, detail: registration.detail, site: at(registration.site) });
    }
  }
  for (const [id, asks] of constructed) {
    for (const member of injected(id)) {
      // An undecorated parameter property is passed because a sibling parameter asks.
      const [decorator = asks] = decoratorsOf(member.node);
      found.push({
        id: member.id,
        detail: `injected by ${spelledDecorator(decorator)}`,
        site: at(decorator),
      });
    }
  }
  return found;
}
