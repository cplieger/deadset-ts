import type { Finding } from "../finding.ts";
import { OUTSIDE, type Graph } from "../graph.ts";
import type { InventorySymbol, SymbolKind } from "../inventory.ts";
import type { MatrixCandidate } from "../matrix.ts";
import type { RootKind } from "../roots.ts";
import type { Emitter, EmitterInput } from "./emitter.ts";
import { writeOnlyDeclarations } from "./reads-and-writes.ts";

const UNNECESSARY_EXPORT = "DS1101";
const UNREACHABLE_EXPORT = "DS1103";
const REDUNDANT_EXPORT_KEYWORD = "DS1104";

/** How far the references to one declaration reach, from the narrowest. */
type Reach = "file" | "package" | "outside";

/**
 * The root kinds by which a consumer importing the package reaches a declaration. A
 * declaration or a file rooted by any other kind is entered by something that names it
 * from outside the reference graph: a runtime, a tool, a framework or the configuration.
 */
const PUBLISHING: ReadonlySet<RootKind> = new Set<RootKind>(["manifest-entry", "published-api"]);

/** The reader's word for each kind of declaration this family reports. */
const WORDS: Partial<Readonly<Record<SymbolKind, string>>> = {
  function: "function",
  class: "class",
  interface: "interface",
  type: "type alias",
  enum: "enum",
  namespace: "namespace",
  variable: "variable",
  "export-alias": "re-export",
};

/** Per declaration of the run, the facts both rules read. */
interface Facts {
  readonly graph: Graph;
  /** The position of the file that holds each declaration. */
  readonly fileOf: readonly number[];
  /** The root kinds naming each declaration. */
  readonly rootedBy: readonly ReadonlySet<RootKind>[];
  /** Per file, whether a manifest export reaches a declaration it holds. */
  readonly published: readonly boolean[];
  /** Per declaration, how many references name it, and how far they reach. */
  readonly named: readonly number[];
  readonly reach: readonly Reach[];
}

function publishes(kinds: ReadonlySet<RootKind> | undefined): boolean {
  return [...(kinds ?? [])].some((kind) => PUBLISHING.has(kind));
}

function entersByName(kinds: ReadonlySet<RootKind> | undefined): boolean {
  return [...(kinds ?? [])].some((kind) => !PUBLISHING.has(kind));
}

/**
 * Folds the run's references into the reach of each declaration.
 *
 * A reference reaches the file that holds the declaration that makes it. A reference
 * from a declaration the inventory does not hold is made by a consumer, and one from a
 * re-export a manifest export reaches stands for every consumer importing the name it
 * publishes; either reaches outside the package.
 */
function factsOf(graph: Graph): Facts {
  const { symbols, parent } = graph;
  const fileOf = symbols.map((_symbol, at) => {
    let file = at;
    while (file !== OUTSIDE && symbols[file]?.kind !== "file") {
      file = parent[file] ?? OUTSIDE;
    }
    return file;
  });
  const rootedBy = symbols.map(() => new Set<RootKind>());
  for (const root of graph.rooted) {
    rootedBy[root.at]?.add(root.kind);
  }
  const published = symbols.map(() => false);
  symbols.forEach((_symbol, at) => {
    const file = fileOf[at] ?? OUTSIDE;
    if (file !== OUTSIDE && publishes(rootedBy[at])) {
      published[file] = true;
    }
  });

  const order: readonly Reach[] = ["file", "package", "outside"];
  const wider = (a: Reach, b: Reach): Reach => (order.indexOf(a) >= order.indexOf(b) ? a : b);
  const inGraph = symbols.map(() => 0);
  const reach = symbols.map((): Reach => "file");
  graph.out.forEach((edges, from) => {
    const republished = symbols[from]?.kind === "export-alias" && publishes(rootedBy[from]);
    for (const edge of edges) {
      inGraph[edge.to] = (inGraph[edge.to] ?? 0) + 1;
      const scope: Reach = republished
        ? "outside"
        : fileOf[from] === fileOf[edge.to]
          ? "file"
          : "package";
      reach[edge.to] = wider(reach[edge.to] ?? "file", scope);
    }
  });
  const named = graph.made.map((counts) => counts.production + counts.test);
  named.forEach((count, at) => {
    if (count > (inGraph[at] ?? 0)) {
      reach[at] = "outside";
    }
  });
  return { graph, fileOf, rootedBy, published, named, reach };
}

/** Whether one declaration is a declaration its file's export table names. */
function topLevelExport(facts: Facts, at: number, symbol: InventorySymbol): boolean {
  const parent = facts.graph.parent[at] ?? OUTSIDE;
  return symbol.exported && parent !== OUTSIDE && facts.graph.symbols[parent]?.kind === "file";
}

function wordOf(symbol: InventorySymbol): string {
  return WORDS[symbol.kind] ?? symbol.kind;
}

/** The visibility each narrowing code names, which only the narrowing codes carry. */
const NARROWER: Readonly<Record<string, "file" | "package">> = {
  [REDUNDANT_EXPORT_KEYWORD]: "file",
  [UNNECESSARY_EXPORT]: "package",
};

function findingOf(symbol: InventorySymbol, code: string, message: string): Finding {
  const { path, line, column } = symbol.position;
  const narrower = Object.hasOwn(NARROWER, code) ? NARROWER[code] : undefined;
  const endLine = Math.max(line, symbol.endLine);
  return {
    code,
    position: { path, line, column, endLine },
    symbol: {
      ref: symbol.ref,
      kind: symbol.kind,
      name: symbol.name,
      sizeLines: endLine - line + 1,
    },
    message,
    details: narrower === undefined ? {} : { narrowerVisibility: narrower },
  };
}

/**
 * The narrowing finding about one live declaration, if one holds: an export of a file,
 * no re-export and none the write-only kind reports, that a reference names and nothing
 * enters by name. Every reference inside its own file makes it a redundant export
 * keyword, where no manifest export reaches the file or the world is closed; references
 * from other files of the package alone make a published one unnecessary when closed.
 */
function narrowing(
  facts: Facts,
  at: number,
  symbol: InventorySymbol,
  world: { readonly closed: boolean; readonly writeOnly: ReadonlySet<string> },
): Finding | undefined {
  const { closed } = world;
  const file = facts.fileOf[at] ?? OUTSIDE;
  if (
    !topLevelExport(facts, at, symbol) ||
    world.writeOnly.has(symbol.ref) ||
    symbol.kind === "export-alias" ||
    entersByName(facts.rootedBy[at]) ||
    entersByName(facts.rootedBy[file]) ||
    (facts.named[at] ?? 0) === 0
  ) {
    return undefined;
  }
  const word = wordOf(symbol);
  switch (facts.reach[at]) {
    case "file":
      if (facts.published[file] === true && !closed) {
        return undefined;
      }
      return findingOf(
        symbol,
        REDUNDANT_EXPORT_KEYWORD,
        `exported ${word} is referenced only inside the file that declares it`,
      );
    case "package":
      if (!closed || !publishes(facts.rootedBy[at])) {
        return undefined;
      }
      return findingOf(
        symbol,
        UNNECESSARY_EXPORT,
        `exported ${word} is referenced only inside the package that declares it`,
      );
    default:
      return undefined;
  }
}

/**
 * The unreachable-export finding about one dead declaration, if one holds: an unused
 * export no code outside the target can import, because the manifest declares
 * `exports` and no root reaches it. Each arm yields to a more specific kind, so one
 * declaration is reported once: a test whose every subject is dead, an interface, a
 * declaration only a test file references, and a deprecated one.
 */
function unreachable(
  facts: Facts,
  at: number,
  symbol: InventorySymbol,
  candidate: MatrixCandidate,
  input: EmitterInput,
): Finding | undefined {
  if (
    !input.boundary.encapsulated ||
    !topLevelExport(facts, at, symbol) ||
    (facts.rootedBy[at]?.size ?? 0) > 0 ||
    candidate.testOfDeadCode ||
    symbol.kind === "interface" ||
    (candidate.productionRefs === 0 && candidate.testRefs > 0) ||
    (candidate.productionRefs === 0 && input.deprecated.has(symbol.id))
  ) {
    return undefined;
  }
  const found =
    candidate.relation === "reachability"
      ? "is referenced only from declarations that are themselves dead"
      : "has no reference in the target";
  return findingOf(
    symbol,
    UNREACHABLE_EXPORT,
    `exported ${wordOf(symbol)} ${found}, and nothing outside can import the file that declares it`,
  );
}

/**
 * The visibility-narrowing family over one run: `DS1101`, `DS1103` and `DS1104`. A finding
 * about a symbol a declared cross-language edge names is reported here like any other, and
 * the edge's evaluation then holds it pending, because the edge stands for a reference from
 * outside the file and the package whose use is decided in the other language. A
 * declaration of a generated file is reported only where generated files are included.
 */
export function narrowings(input: EmitterInput): readonly Finding[] {
  const facts = factsOf(input.swept.matrix.union);
  const { declared, loaded } = input.boundary.consumers;
  const closed = input.config.consumersComplete && declared.every((id) => loaded.includes(id));
  const world = { closed, writeOnly: writeOnlyDeclarations(input) };
  const candidates = new Map(
    input.swept.sweep.candidates.map((candidate) => [candidate.id, candidate]),
  );
  const generated =
    input.config.analysis.generatedFiles === "include" ? undefined : input.files.generated;

  const findings: Finding[] = [];
  facts.graph.symbols.forEach((symbol, at) => {
    if (generated?.has(symbol.position.path) === true) {
      return;
    }
    const candidate = candidates.get(symbol.id);
    const found =
      candidate === undefined
        ? narrowing(facts, at, symbol, world)
        : unreachable(facts, at, symbol, candidate, input);
    if (found !== undefined) {
      findings.push(found);
    }
  });
  return findings;
}

/**
 * The declarations the unreachable-export kind reports, whether or not a declared edge
 * holds the finding pending: the unused-declaration kinds yield each to it.
 */
export function unreachableExports(input: EmitterInput): ReadonlySet<string> {
  const facts = factsOf(input.swept.matrix.union);
  const found = new Set<string>();
  for (const candidate of input.swept.sweep.candidates) {
    const at = facts.graph.at(candidate.id);
    const symbol = facts.graph.symbols[at];
    if (symbol !== undefined && unreachable(facts, at, symbol, candidate, input) !== undefined) {
      found.add(symbol.id);
    }
  }
  return found;
}

/** The findings of the visibility-narrowing family, `DS1100` to `DS1199`. */
export const visibilityNarrowing: Emitter = narrowings;
