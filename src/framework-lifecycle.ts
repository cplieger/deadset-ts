/**
 * The framework-lifecycle class: a member a `ts.lifecycle_contracts` entry lists is held
 * back on each class that is the entry's component, being a class a decorator or a call
 * the entry's `components` name is attached to or passes, or one extending, directly or
 * through a chain, a class its `bases` name. A component's members are its type's, so a
 * member a base class declares answers for every subclass.
 */

import {
  isClassDeclaration,
  isClassExpression,
  isHeritageClause,
  SyntaxKind,
  type CallExpression,
  type Node,
} from "@typescript/native/unstable/ast";
import type { Type } from "@typescript/native/unstable/sync";
import { aliasChains, type AliasChains } from "./alias-chain.ts";
import { calleeName, callsOf, classesPassed, decoratedClasses, decoratorCallee } from "./calls.ts";
import { classMembers, memberComponent, typesAt, type ClassSide } from "./class-members.ts";
import type { DeclarationEntry, LifecycleContract } from "./config.ts";
import {
  entriesAt,
  names,
  namesADeclaration,
  resolveEntries,
  spelledEntry,
  type ResolvedEntry,
} from "./configured-declarations.ts";
import type { DetectorInput, Evidence } from "./exempt.ts";
import { nodeKey, type Inventory } from "./inventory.ts";
import { renderPosition } from "./position.ts";
import type { ProjectView } from "./session.ts";

/** One class that is a component of one contract, and what says it is. */
interface Component {
  readonly contract: LifecycleContract;
  readonly id: string;
  readonly site: Node;
  readonly detail: string;
}

/** One contract's declarations, resolved in the project. */
interface ResolvedContract {
  readonly contract: LifecycleContract;
  readonly components: readonly ResolvedEntry[];
  readonly bases: readonly ResolvedEntry[];
}

/** Every contract's components and bases, resolved in one pass over the entries. */
function resolveContracts<Brand>(
  project: ProjectView<Brand>,
  held: Inventory,
  contracts: readonly LifecycleContract[],
): readonly ResolvedContract[] {
  const entries: DeclarationEntry[] = contracts.flatMap((contract) => [
    ...contract.components,
    ...contract.bases,
  ]);
  const resolved = resolveEntries(project, held, entries);
  let next = 0;
  const take = (count: number): readonly ResolvedEntry[] => {
    const taken = resolved.slice(next, next + count).filter(namesADeclaration);
    next += count;
    return taken;
  };
  return contracts.map((contract) => ({
    contract,
    components: take(contract.components.length),
    bases: take(contract.bases.length),
  }));
}

/** The classes a decorator or a call the contracts' components name makes a component. */
function byComponents<Brand>(
  project: ProjectView<Brand>,
  held: Inventory,
  chains: AliasChains,
  contracts: readonly ResolvedContract[],
): readonly Component[] {
  const routed = contracts.filter((one) => one.components.length > 0);
  if (routed.length === 0) {
    return [];
  }
  const contractOf = new Map(
    routed.flatMap((one) => one.components.map((entry) => [entry, one.contract] as const)),
  );
  const calls = callsOf(project);
  const decorated = decoratedClasses(project, held);
  const named = entriesAt(
    project,
    chains,
    [
      ...calls.flatMap((call) => calleeName(call.expression) ?? []),
      ...decorated.flatMap((one) =>
        one.decorators.flatMap((decorator) => decoratorCallee(decorator) ?? []),
      ),
    ],
    [...contractOf.keys()],
  );
  const naming = (node: Node | undefined): { contract: LifecycleContract; detail: string }[] =>
    (node === undefined ? [] : (named.get(node) ?? [])).flatMap((entry) => {
      const contract = contractOf.get(entry);
      return contract === undefined ? [] : [{ contract, detail: spelledEntry(entry.entry, held) }];
    });

  const found: Component[] = [];
  for (const one of decorated) {
    for (const decorator of one.decorators) {
      for (const { contract, detail } of naming(decoratorCallee(decorator))) {
        found.push({ contract, id: one.id, site: decorator, detail: `decorated by @${detail}` });
      }
    }
  }
  const matched = new Map<CallExpression, { contract: LifecycleContract; detail: string }[]>();
  for (const call of calls) {
    const routes = naming(calleeName(call.expression));
    if (routes.length > 0) {
      matched.set(call, routes);
    }
  }
  for (const [call, uses] of classesPassed(project, held, chains, [...matched.keys()])) {
    for (const route of matched.get(call) ?? []) {
      for (const use of uses) {
        found.push({
          contract: route.contract,
          id: use.id,
          site: use.site,
          detail: `registered by ${route.detail}`,
        });
      }
    }
  }
  return found;
}

/** Each class declaration of the target, with its name and the class its `extends` names. */
interface Declared {
  readonly id: string;
  readonly name: Node;
  readonly extended: Node;
}

/** The class declarations of the target that extend another class. */
function extendingClasses<Brand>(
  project: ProjectView<Brand>,
  held: Inventory,
): readonly Declared[] {
  const found: Declared[] = [];
  for (const file of project.ownSourceFiles()) {
    const visit = (node: Node): void => {
      if ((isClassDeclaration(node) || isClassExpression(node)) && node.name !== undefined) {
        const id = held.declarations.get(nodeKey(file, node));
        const clause = (node.heritageClauses ?? []).find(
          (one) => isHeritageClause(one) && one.token === SyntaxKind.ExtendsKeyword,
        );
        const extended =
          clause !== undefined && isHeritageClause(clause) ? clause.types[0] : undefined;
        if (id !== undefined && extended !== undefined) {
          found.push({ id, name: node.name, extended });
        }
      }
      node.forEachChild(visit);
    };
    file.forEachChild(visit);
  }
  return found;
}

/** The classes that extend, directly or through a chain, a class the contracts' bases name. */
function byBases<Brand>(
  project: ProjectView<Brand>,
  held: Inventory,
  chains: AliasChains,
  contracts: readonly ResolvedContract[],
): readonly Component[] {
  const based = contracts.filter((one) => one.bases.length > 0);
  if (based.length === 0) {
    return [];
  }
  const classes = extendingClasses(project, held);
  if (classes.length === 0) {
    return [];
  }
  const checker = project.checker;
  const ancestry = new Map<number, readonly Type[]>();
  const ancestorsOf = (type: Type, seen: Set<number>): readonly Type[] => {
    const known = ancestry.get(type.id);
    if (known !== undefined) {
      return known;
    }
    const declared = type.isClassOrInterface()
      ? type
      : type.isTypeReference()
        ? type.getTarget()
        : undefined;
    if (declared === undefined || !declared.isClassOrInterface() || seen.has(declared.id)) {
      return [];
    }
    seen.add(declared.id);
    const found = checker
      .getBaseTypes(declared)
      .flatMap((base) => [base, ...ancestorsOf(base, seen)]);
    ancestry.set(type.id, found);
    return found;
  };
  const types = typesAt(
    project,
    classes.map((one) => one.name),
  );

  const found: Component[] = [];
  classes.forEach((one, index) => {
    const type = types[index];
    if (type === undefined) {
      return;
    }
    const ancestors = ancestorsOf(type, new Set()).flatMap((base) => base.getSymbol() ?? []);
    for (const contract of based) {
      for (const entry of contract.bases) {
        if (ancestors.some((symbol) => names(entry, symbol, chains))) {
          found.push({
            contract: contract.contract,
            id: one.id,
            site: one.extended,
            detail: `extends ${spelledEntry(entry.entry, held)}`,
          });
        }
      }
    }
  });
  return found;
}

/**
 * The framework-lifecycle detector: each member a contract lists, on each class that
 * is a component of that contract's framework, recorded where the class was found to
 * be one.
 */
export function frameworkLifecycle<Brand>(input: DetectorInput<Brand>): readonly Evidence[] {
  const { project, held, targetRoot } = input;
  if (input.ts.lifecycleContracts.length === 0) {
    return [];
  }
  const chains = aliasChains(project, held);
  const contracts = resolveContracts(project, held, input.ts.lifecycleContracts);
  const components = [
    ...byComponents(project, held, chains, contracts),
    ...byBases(project, held, chains, contracts),
  ];
  if (components.length === 0) {
    return [];
  }
  const ids = new Set(components.map((one) => one.id));
  const sides: readonly ClassSide[] = input.ts.lifecycleContracts.some((contract) =>
    contract.members.some((name) => name.endsWith(":static")),
  )
    ? ["instance", "static"]
    : ["instance"];
  const members = sides.map((side) => classMembers(project, held, ids, side));
  const byId = new Map(held.symbols.map((symbol) => [symbol.id, symbol]));

  const found: Evidence[] = [];
  for (const component of components) {
    const listed = new Set(component.contract.members);
    const site = renderPosition(
      component.site.getSourceFile(),
      targetRoot,
      component.site.getStart(),
    );
    for (const member of members.flatMap((side) => side.get(component.id) ?? [])) {
      const symbol = byId.get(member.id);
      const spelled = symbol === undefined ? undefined : memberComponent(symbol, byId);
      if (spelled !== undefined && listed.has(spelled)) {
        found.push({ id: member.id, detail: component.detail, site });
      }
    }
  }
  return found;
}
