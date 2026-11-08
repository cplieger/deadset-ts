/**
 * The framework-lifecycle class: a member a lifecycle contract lists is held back on each
 * class that is the contract's component, being a class a decorator or a call the
 * contract's `components` name is attached to or passes, or one extending, directly or
 * through a chain, a class its `bases` name. The contracts are the platform's custom
 * elements and each `ts.lifecycle_contracts` entry. A component's members are its type's,
 * so a member a base class declares answers for every subclass.
 */

import {
  isHeritageClause,
  SyntaxKind,
  type CallExpression,
  type Node,
} from "@typescript/native/ast";
import type { Type } from "@typescript/native/sync";
import { aliasChains, type AliasChains } from "../alias-chain.ts";
import { nameOf } from "../index/values.ts";
import { classesPassed, decoratorCallee, decoratorsOf } from "./calls.ts";
import { classMembers, memberComponent, typesAt, type ClassSide } from "../class-members.ts";
import type { DeclarationEntry, LifecycleContract } from "../config.ts";
import {
  entriesAt,
  names,
  namesADeclaration,
  resolveEntries,
  spelledEntry,
  type ResolvedEntry,
} from "../roots/configured-declarations.ts";
import type { DetectorInput, Evidence } from "./lifecycle.ts";
import type { Inventory } from "../inventory.ts";
import { renderPosition } from "../position.ts";
import { must } from "../query.ts";
import type { ProjectView } from "../session.ts";
import type { ProjectSites } from "./sites.ts";

/**
 * The platform's own contract (references-ts.38): `CustomElementRegistry.define` reads
 * these members off the class it registers, its constructor's and its prototype's
 * (https://html.spec.whatwg.org/multipage/custom-elements.html#dom-customelementregistry-define),
 * and calls each callback as a custom element reaction.
 */
const CUSTOM_ELEMENTS: LifecycleContract = {
  components: [{ global: "CustomElementRegistry.define" }],
  members: [
    "observedAttributes:static",
    "disabledFeatures:static",
    "formAssociated:static",
    "connectedCallback",
    "disconnectedCallback",
    "connectedMoveCallback",
    "adoptedCallback",
    "attributeChangedCallback",
    "formAssociatedCallback",
    "formResetCallback",
    "formDisabledCallback",
    "formStateRestoreCallback",
  ],
};

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
    ...(contract.components ?? []),
    ...(contract.bases ?? []),
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
    components: take(contract.components?.length ?? 0),
    bases: take(contract.bases?.length ?? 0),
  }));
}

/** The classes a decorator or a call the contracts' components name makes a component. */
function byComponents<Brand>(
  project: ProjectView<Brand>,
  held: Inventory,
  sites: ProjectSites,
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
  const calls = sites.calls.map((one) => one.call);
  const invoked = (call: CallExpression): Node | undefined =>
    nameOf(sites.invocations.of(call).callee);
  const decorated = sites.classes.flatMap(({ id, node }) => {
    const decorators = decoratorsOf(node);
    return decorators.length === 0 ? [] : [{ id, decorators }];
  });
  const named = entriesAt(
    project,
    chains,
    [
      ...calls.flatMap((call) => invoked(call) ?? []),
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
    const routes = naming(invoked(call));
    if (routes.length > 0) {
      matched.set(call, routes);
    }
  }
  for (const [call, uses] of classesPassed(project, held, chains, sites, [...matched.keys()])) {
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

/** Each named class of the target that extends another, with its name and the class its `extends` names. */
function extendingClasses(sites: ProjectSites): readonly {
  readonly id: string;
  readonly name: Node;
  readonly extended: Node;
}[] {
  return sites.classes.flatMap(({ id, node }) => {
    const clause = (node.heritageClauses ?? []).find(
      (one) => isHeritageClause(one) && one.token === SyntaxKind.ExtendsKeyword,
    );
    const extended = clause !== undefined && isHeritageClause(clause) ? clause.types[0] : undefined;
    return node.name === undefined || extended === undefined
      ? []
      : [{ id, name: node.name, extended }];
  });
}

/** The classes that extend, directly or through a chain, a class the contracts' bases name. */
function byBases<Brand>(
  project: ProjectView<Brand>,
  held: Inventory,
  sites: ProjectSites,
  chains: AliasChains,
  contracts: readonly ResolvedContract[],
): readonly Component[] {
  const based = contracts.filter((one) => one.bases.length > 0);
  if (based.length === 0) {
    return [];
  }
  const classes = extendingClasses(sites);
  if (classes.length === 0) {
    return [];
  }
  const queries = project.queries;
  const ancestry = new Map<number, readonly Type[]>();
  const ancestorsOf = (type: Type, seen: Set<number>): readonly Type[] => {
    const known = ancestry.get(type.id);
    if (known !== undefined) {
      return known;
    }
    const declared = type.isClassOrInterface()
      ? type
      : type.isTypeReference()
        ? must(queries.targetOf(type))
        : undefined;
    if (declared === undefined || !declared.isClassOrInterface() || seen.has(declared.id)) {
      return [];
    }
    seen.add(declared.id);
    const found = must(queries.baseTypes(declared)).flatMap((base) => [
      base,
      ...ancestorsOf(base, seen),
    ]);
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
    const ancestors = ancestorsOf(type, new Set()).flatMap(
      (base) => must(queries.symbolOfType(base)) ?? [],
    );
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
 * is a component of that contract's framework, recorded once per place where the class
 * was found to be one.
 */
export function frameworkLifecycle<Brand>(input: DetectorInput<Brand>): readonly Evidence[] {
  const { project, held, targetRoot } = input;
  const declared = [CUSTOM_ELEMENTS, ...input.ts.lifecycle_contracts];
  const contracts = resolveContracts(project, held, declared);
  if (contracts.every((one) => one.components.length === 0 && one.bases.length === 0)) {
    return [];
  }
  const chains = aliasChains(project, held);
  const components = [
    ...byComponents(project, held, input.sites, chains, contracts),
    ...byBases(project, held, input.sites, chains, contracts),
  ];
  if (components.length === 0) {
    return [];
  }
  const ids = new Set(components.map((one) => one.id));
  const sides: readonly ClassSide[] = declared.some((contract) =>
    contract.members.some((name) => name.endsWith(":static")),
  )
    ? ["instance", "static"]
    : ["instance"];
  const members = sides.map((side) => classMembers(project, held, ids, side));
  const byId = new Map(held.symbols.map((symbol) => [symbol.id, symbol]));

  const found = new Map<string, Evidence>();
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
      // A configured contract may name the platform's registry too; one record answers both.
      const key = `${member.id}\0${component.detail}\0${site.path}:${String(site.line)}:${String(site.column)}`;
      if (spelled !== undefined && listed.has(spelled) && !found.has(key)) {
        found.set(key, { id: member.id, detail: component.detail, site });
      }
    }
  }
  return [...found.values()];
}
