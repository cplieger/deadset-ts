/**
 * Which classes of the target implement which of its interfaces, and how each writes
 * every method such an interface declares. A class implements an interface its
 * `implements` clause names, in any instantiation, or one with a member its instance
 * type is assignable to, asked only of a class carrying every member the interface
 * requires and one it declares, and never of a generic side.
 */

import {
  isClassDeclaration,
  isHeritageClause,
  isInterfaceDeclaration,
  isMethodDeclaration,
  SyntaxKind,
  type Node,
} from "@typescript/native/unstable/ast";
import { SymbolFlags, type Symbol as TSSymbol, type Type } from "@typescript/native/unstable/sync";
import { aliasChains } from "./alias-chain.ts";
import { nodeKey, type Inventory } from "./inventory.ts";
import { must, Unanswerable } from "./query.ts";
import type { ProjectView } from "./session.ts";

/** What one run knows about how its interfaces are implemented. */
export interface Implementations {
  /** Per interface declaration, the classes that implement it, each by its identifier. */
  readonly classes: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * Per method an interface declares, each class that implements it and whether that
   * class's implementation is a method whose body holds no statement.
   */
  readonly bodies: ReadonlyMap<string, ReadonlyMap<string, boolean>>;
  /**
   * The interface methods whose implementations a project could not read in full,
   * because the checker left a question about them unanswered. Each is treated as a
   * marker, whose every implementation is empty, so none is reported for want of an
   * answer.
   */
  readonly unknown: ReadonlySet<string>;
}

/** One interface or class the inventory holds, by its declaration. */
interface Declared {
  readonly id: string;
  readonly nameNode: Node;
  readonly generic: boolean;
}

/** One entry of a class's `implements` clause. */
interface Clause {
  readonly owner: Declared;
  readonly entry: Node;
}

/** One interface type, the declarations it has, and the members it carries. */
interface InterfaceAt {
  readonly ids: string[];
  readonly type: Type;
  generic: boolean;
  members?: readonly TSSymbol[];
}

/** One class, its instance type, and the members that type carries by name. */
interface ClassAt {
  readonly owner: Declared;
  readonly type: Type;
  members?: ReadonlyMap<string, TSSymbol>;
}

/** The interfaces, the classes and the `implements` entries of one project's own files. */
function walk<Brand>(
  project: ProjectView<Brand>,
  held: Inventory,
): {
  readonly interfaces: readonly Declared[];
  readonly classes: readonly Declared[];
  readonly clauses: readonly Clause[];
} {
  const interfaces: Declared[] = [];
  const classes: Declared[] = [];
  const clauses: Clause[] = [];
  for (const file of project.ownSourceFiles()) {
    const visit = (node: Node): void => {
      if (isInterfaceDeclaration(node) || isClassDeclaration(node)) {
        const id = held.declarations.get(nodeKey(file, node));
        const name = node.name;
        if (id !== undefined && name !== undefined) {
          const declared = { id, nameNode: name, generic: node.typeParameters !== undefined };
          if (isInterfaceDeclaration(node)) {
            interfaces.push(declared);
          } else {
            classes.push(declared);
            for (const clause of node.heritageClauses ?? []) {
              if (isHeritageClause(clause) && clause.token === SyntaxKind.ImplementsKeyword) {
                clauses.push(...clause.types.map((entry) => ({ owner: declared, entry })));
              }
            }
          }
        }
      }
      node.forEachChild(visit);
    };
    file.forEachChild(visit);
  }
  return { interfaces, classes, clauses };
}

/** The type at each node. */
function typesAt<Brand>(project: ProjectView<Brand>, nodes: readonly Node[]): Map<Node, Type> {
  const typeAt = new Map<Node, Type>();
  project.queries.typesAt(nodes).forEach((answer, index) => {
    const type = must(answer);
    const node = nodes[index];
    if (type !== undefined && node !== undefined) {
      typeAt.set(node, type);
    }
  });
  return typeAt;
}

/** Whether one class member is a method whose every written body holds no statement. */
export function emptyImplementation<Brand>(project: ProjectView<Brand>, member: TSSymbol): boolean {
  const own = project.ownPaths();
  let bodies = 0;
  for (const handle of member.declarations) {
    // A body outside the target is one this analysis cannot read, so it is not empty.
    if (!own.has(handle.path)) {
      return false;
    }
    const node = project.declarationAt(handle)?.node;
    if (node === undefined || !isMethodDeclaration(node)) {
      return false;
    }
    if (node.body !== undefined) {
      if (node.body.statements.length > 0) {
        return false;
      }
      bodies += 1;
    }
  }
  return bodies > 0;
}

/**
 * How one project's interfaces are implemented by its classes. Where the checker leaves
 * a question unanswered, what was read stands and every interface method of the project
 * is named in {@link Implementations.unknown}.
 */
export function implementations<Brand>(
  project: ProjectView<Brand>,
  held: Inventory,
): Implementations {
  const classes = new Map<string, Set<string>>();
  const bodies = new Map<string, Map<string, boolean>>();
  try {
    implementedIn(project, held, classes, bodies);
    return { classes, bodies, unknown: new Set() };
  } catch (error: unknown) {
    if (!(error instanceof Unanswerable)) {
      throw error;
    }
    const methods = held.symbols.filter((symbol) => symbol.kind === "interface-method");
    return { classes, bodies, unknown: new Set(methods.map((symbol) => symbol.id)) };
  }
}

function implementedIn<Brand>(
  project: ProjectView<Brand>,
  held: Inventory,
  classes: Map<string, Set<string>>,
  bodies: Map<string, Map<string, boolean>>,
): void {
  const walked = walk(project, held);
  if (walked.interfaces.length === 0 || walked.classes.length === 0) {
    return;
  }

  const queries = project.queries;
  const typeAt = typesAt(project, [
    ...walked.interfaces.map((one) => one.nameNode),
    ...walked.classes.map((one) => one.nameNode),
    ...walked.clauses.map((clause) => clause.entry),
  ]);

  // Two declarations of one interface merge into one type.
  const byType = new Map<number, InterfaceAt>();
  for (const declared of walked.interfaces) {
    const type = typeAt.get(declared.nameNode);
    if (type === undefined) {
      continue;
    }
    const merged = byType.get(type.id);
    if (merged === undefined) {
      byType.set(type.id, { ids: [declared.id], type, generic: declared.generic });
    } else {
      merged.ids.push(declared.id);
      merged.generic ||= declared.generic;
    }
  }
  const classAt = new Map<string, ClassAt>();
  for (const owner of walked.classes) {
    const type = typeAt.get(owner.nameNode);
    if (type !== undefined) {
      classAt.set(owner.id, { owner, type });
    }
  }

  const membersOf = (at: InterfaceAt): readonly TSSymbol[] =>
    (at.members ??= must(queries.propertiesOf(at.type)));
  const classMembers = (at: ClassAt): ReadonlyMap<string, TSSymbol> =>
    (at.members ??= new Map(
      must(queries.propertiesOf(at.type)).map((member) => [member.escapedName, member]),
    ));

  const methodIds = new Set(
    held.symbols.filter((symbol) => symbol.kind === "interface-method").map((symbol) => symbol.id),
  );
  const chains = aliasChains(project, held);
  const record = (at: InterfaceAt, implementer: ClassAt): void => {
    for (const id of at.ids) {
      let set = classes.get(id);
      if (set === undefined) {
        set = new Set();
        classes.set(id, set);
      }
      set.add(implementer.owner.id);
    }
    const written = classMembers(implementer);
    for (const member of membersOf(at)) {
      const answering = written.get(member.escapedName);
      if (answering === undefined) {
        continue;
      }
      const empty = emptyImplementation(project, answering);
      for (const id of chains.declarationsOf(member)) {
        if (!methodIds.has(id)) {
          continue;
        }
        let byClass = bodies.get(id);
        if (byClass === undefined) {
          byClass = new Map();
          bodies.set(id, byClass);
        }
        byClass.set(implementer.owner.id, empty);
      }
    }
  };

  const recorded = new Set<string>();
  const pair = (at: InterfaceAt, implementer: ClassAt): void => {
    const key = `${String(at.type.id)}:${implementer.owner.id}`;
    if (!recorded.has(key)) {
      recorded.add(key);
      record(at, implementer);
    }
  };

  for (const clause of walked.clauses) {
    const entry = typeAt.get(clause.entry);
    const implementer = classAt.get(clause.owner.id);
    if (entry === undefined || implementer === undefined) {
      continue;
    }
    const at = byType.get(must(queries.targetOf(entry)).id);
    if (at !== undefined) {
      pair(at, implementer);
    }
  }

  // Every pair whose names line up is asked about at once.
  const candidates: { readonly at: InterfaceAt; readonly implementer: ClassAt }[] = [];
  for (const at of byType.values()) {
    const members = at.generic ? [] : membersOf(at);
    if (members.length === 0) {
      continue;
    }
    const required = members.filter((member) => (member.flags & SymbolFlags.Optional) === 0);
    for (const implementer of classAt.values()) {
      if (implementer.owner.generic) {
        continue;
      }
      const written = classMembers(implementer);
      if (
        required.every((member) => written.has(member.escapedName)) &&
        members.some((member) => written.has(member.escapedName))
      ) {
        candidates.push({ at, implementer });
      }
    }
  }
  const assignable = queries.assignableEach(
    candidates.map((one) => ({ source: one.implementer.type, target: one.at.type })),
  );
  candidates.forEach((one, index) => {
    if (must(assignable[index] ?? false)) {
      pair(one.at, one.implementer);
    }
  });
}

/** Every project's answers as one run's, each implementation once. */
export function mergeImplementations(per: readonly Implementations[]): Implementations {
  const unknown = new Set(per.flatMap((one) => [...one.unknown]));
  const classes = new Map<string, Set<string>>();
  const bodies = new Map<string, Map<string, boolean>>();
  for (const one of per) {
    for (const [id, held] of one.classes) {
      const set = classes.get(id) ?? new Set();
      classes.set(id, set);
      for (const owner of held) {
        set.add(owner);
      }
    }
    for (const [id, held] of one.bodies) {
      const byClass = bodies.get(id) ?? new Map<string, boolean>();
      bodies.set(id, byClass);
      for (const [owner, empty] of held) {
        byClass.set(owner, (byClass.get(owner) ?? true) && empty);
      }
    }
  }
  return { classes, bodies, unknown };
}
