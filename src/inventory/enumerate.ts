import { isShorthandPropertyAssignment, ModifierFlags, type Node } from "@typescript/native/ast";
import type { Symbol as TSSymbol } from "@typescript/native/sync";
import type { Host } from "../host.ts";
import {
  Builder,
  modifiersOf,
  type Building,
  type Container,
  type DeclarationSource,
  type Inventory,
  type InventoryCost,
} from "../inventory.ts";
import { packageScope, packageTypeIsModule } from "../load/package-scope.ts";
import { relativePath } from "../paths.ts";
import { renderPosition } from "../position.ts";
import { isAnswered, UNANSWERED } from "../query.ts";
import type { Handle, ProjectView } from "../session.ts";
import { commonJS, type Resolved } from "./commonjs.ts";
import { SYNTAX } from "./syntax.ts";

/**
 * Every declaration one project's own files hold, in rendered position order.
 *
 * `targetRoot` is the absolute path every position is rendered against; a file the program
 * holds that is not below it ends the enumeration. `host` is the filesystem the manifests
 * that name each file's package are read through, and nothing else is read from it.
 */
export function inventory<Brand>(
  project: ProjectView<Brand>,
  host: Host,
  targetRoot: string,
): Inventory {
  const files = project.ownSourceFiles();
  const moduleOf = packageScope(host, targetRoot);
  const sources: readonly DeclarationSource[] = [
    SYNTAX,
    commonJS(packageTypeIsModule(host, targetRoot), resolvedIn(project)),
  ];
  const into = new Builder(targetRoot);
  for (const file of files) {
    const path = relativePath(targetRoot, file.fileName);
    if (path === undefined) {
      // renderPosition states the refusal, with the root it was rendered against.
      renderPosition(file, targetRoot, 0);
      continue;
    }
    const owner = into.file(file, moduleOf(path), path);
    for (const source of sources) {
      source.declare(file, owner, into);
    }
  }
  return into.build(readTables(project, into, new Set(files.map((file) => file.fileName))));
}

/** The declarations of this program each occurrence resolves to, asked in one batch. */
function resolvedIn<Brand>(project: ProjectView<Brand>): Resolved {
  return (occurrences) => {
    const symbols = project.symbolsAt(occurrences.map((occurrence) => project.handle(occurrence)));
    return occurrences.map((occurrence, index) => {
      // A shorthand property's name resolves to the property it declares, not the binding.
      const symbol = isShorthandPropertyAssignment(occurrence.parent)
        ? project.shorthandValueAt(project.handle(occurrence.parent))
        : symbols[index];
      return typeof symbol === "object"
        ? symbol.declarations.flatMap(
            (declaration) => project.declarationAt(declaration)?.node ?? [],
          )
        : [];
    });
  };
}

/**
 * The binder's half: which declarations each module and namespace exports, and the members
 * each container's symbol tables hold, then the members only its tree holds. One batch
 * resolves every scope and container, because an accessor with an array overload costs one
 * round trip for the batch and one per node without it.
 */
function readTables<Brand>(
  project: ProjectView<Brand>,
  into: Builder,
  ownFiles: ReadonlySet<string>,
): InventoryCost {
  const scopes = into.exportScopes;
  const named = into.containers.filter((container) => container.nameNode !== undefined);
  const batched: Node[] = [
    ...scopes.map((scope) => scope.nameNode),
    ...named.flatMap((container) => container.nameNode ?? []),
  ];
  const handles: Handle<Brand>[] = batched.map((node) => project.handle(node));
  const resolved = project.symbolsAt(handles);
  const symbolOf = new Map<Node, TSSymbol>();
  batched.forEach((node, index) => {
    const symbol = resolved[index];
    if (typeof symbol === "object") {
      symbolOf.set(node, symbol);
    }
  });
  // A scope or a container whose symbol or table went unanswered keeps what its syntax
  // declares, and everything under it is recorded unanswered.
  scopes.forEach((scope, index) => {
    if (resolved[index] === UNANSWERED) {
      into.unanswered(scope.owner);
    }
  });
  named.forEach((container, index) => {
    if (resolved[scopes.length + index] === UNANSWERED) {
      into.unanswered(container.owner);
    }
  });

  let exportTables = 0;
  for (const scope of scopes) {
    const symbol = symbolOf.get(scope.nameNode);
    if (symbol === undefined) {
      continue;
    }
    exportTables += 1;
    const table = project.queries.exportsOf(symbol);
    if (!isAnswered(table)) {
      into.unanswered(scope.owner);
      continue;
    }
    for (const [, exported] of table) {
      for (const declaration of exported.declarations) {
        const held = project.declarationAt(declaration);
        const record = held === undefined ? undefined : into.recordAt(held.node);
        if (record !== undefined) {
          record.exported = true;
        }
      }
    }
  }

  let memberTables = 0;
  const readTable = (
    container: Container,
    table: ReadonlyMap<string, TSSymbol>,
    seen: Map<string, Building>,
    areStatic: boolean,
  ): void => {
    for (const [, member] of table) {
      const declarations = member.declarations.flatMap(
        (handle) => project.declarationAt(handle) ?? [],
      );
      // A member with no declaration is the language's own (a class's `prototype`), and a
      // member declared outside the target's own files belongs to another program. A
      // merged symbol's table holds the members every one of its declarations writes, and
      // each member is kept once, by the declaration that writes it.
      for (const held of declarations) {
        const node = held.node;
        if (
          ownFiles.has(node.getSourceFile().fileName) &&
          writtenInside(container.declaration, node)
        ) {
          into.member(container, node, seen, areStatic);
        }
      }
    }
  };
  for (const container of into.containers) {
    const symbol = container.nameNode === undefined ? undefined : symbolOf.get(container.nameNode);
    const seen = new Map<string, Building>();
    const isClass = container.memberKind === "class-member";
    const isEnum = container.memberKind === "enum-member";
    if (symbol !== undefined) {
      if (!isEnum) {
        memberTables += 1;
        const table = project.queries.membersOf(symbol);
        if (isAnswered(table)) {
          readTable(container, table, seen, false);
        } else {
          into.unanswered(container.owner);
        }
      }
      if (isEnum || isClass) {
        memberTables += 1;
        const table = project.queries.exportsOf(symbol);
        if (isAnswered(table)) {
          readTable(container, table, seen, isClass);
        } else {
          into.unanswered(container.owner);
        }
      }
    }
    // A member whose key is computed is bound to the container's type later than the
    // table is built, so only the container's own declaration names it.
    for (const member of container.members) {
      into.member(container, member, seen, (modifiersOf(member) & ModifierFlags.Static) !== 0);
    }
  }
  return { batches: 1, exportTables, memberTables };
}

/** Whether `node` is written inside `declaration`, compared by file and range. */
function writtenInside(declaration: Node, node: Node): boolean {
  return (
    node.getSourceFile().fileName === declaration.getSourceFile().fileName &&
    declaration.pos <= node.pos &&
    node.end <= declaration.end
  );
}
