/**
 * The subject index of one run: every fact about the run's declarations and files that
 * more than one reader of the findings stage reads, built once per sweep. The code tables,
 * the family emitters and the completion stages read it, and none of them derives one of
 * these facts again.
 */

import type { Confidence } from "../contract/contract.generated.ts";
import type { InventorySymbol, SymbolKind } from "../inventory.ts";
import { OUTSIDE, type Graph } from "../liveness/graph.ts";
import type { Candidate } from "../liveness/sweep.ts";
import { positionKey } from "../position.ts";
import { declarationKey } from "../ref.ts";
import type { RootKind } from "../roots/root-set.ts";
import type { FindingPosition } from "../finding.ts";
import type { EmitterInput } from "./emitter.ts";

/** How far the references to one declaration reach, from the narrowest. */
type Reach = "file" | "package" | "outside";

/** The root kinds by which a consumer importing the package reaches a declaration. */
export const PUBLISHING: ReadonlySet<RootKind> = new Set<RootKind>([
  "manifest-entry",
  "published-api",
]);

/** Whether one of the root kinds publishes the declaration they name. */
export function publishes(kinds: ReadonlySet<RootKind> | undefined): boolean {
  return [...(kinds ?? [])].some((kind) => PUBLISHING.has(kind));
}

/** Where each declaration's references reach, which the narrowing kinds read. */
interface Visibility {
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

/** How one declaration's counted references divide for the write-only kind. */
interface Uses {
  readonly writes: FindingPosition[];
  reads: number;
  /** The import bindings only the writes use. */
  readonly alone: Set<string>;
}

/** One declaration the write-only kind reports, with its uses. */
export interface WrittenSubject {
  readonly symbol: InventorySymbol;
  readonly held: Uses;
}

/**
 * What the write-only kind answers of one run: its subjects in site order, and the
 * declarations that fall with them, each named under the innermost subject of every chain
 * of carriers its references hold.
 */
interface Written {
  readonly subjects: readonly WrittenSubject[];
  /** The reference and file of each subject, which a narrowing kind yields to. */
  readonly keys: ReadonlySet<string>;
  /** Per subject, the declarations that fall with it, as a message names them. */
  readonly named: ReadonlyMap<string, readonly string[]>;
  /** The ids of the declarations that fall with a subject. */
  readonly falls: ReadonlySet<string>;
}

/** The files of the run, each with whether a reference written in another file reaches it. */
interface KeptFiles {
  /** The files kept: reached from a live file, or named by a root, an edge or a program. */
  readonly kept: ReadonlySet<string>;
  /** The files a reference written in another file reaches, whatever holds that file. */
  readonly referenced: ReadonlySet<string>;
}

/** The facts of one run the findings stage shares. */
export interface Subjects {
  readonly input: EmitterInput;
  readonly union: Graph;
  readonly symbol: (id: string) => InventorySymbol | undefined;
  readonly candidate: (id: string) => Candidate | undefined;
  /** The ids of the sweep's candidates. */
  readonly dead: ReadonlySet<string>;
  /** Per type parameter, the declarations whose references name it. */
  readonly namedBy: () => ReadonlyMap<string, ReadonlySet<string>>;
  /** The declarations the roots name as a library's published API. */
  readonly published: ReadonlySet<string>;
  readonly visibility: () => Visibility;
  readonly written: () => Written;
  readonly files: () => KeptFiles;
  /** The members nothing writes or reads that are brands of their declaring type. */
  readonly brands: () => ReadonlySet<string>;
  /** The reachability class of one declaration, before any ceiling. */
  readonly classOf: (id: string) => Confidence;
  /** The confidence ceiling of a test of dead code, `certain` for every other declaration. */
  readonly testCeiling: (id: string) => Confidence;
  /** The subjects dead only because production code only tests use is. */
  readonly testUsed: () => TestUsed;
}

/** The subjects dead only because production code only tests use is. */
interface TestUsed {
  readonly declarations: ReadonlySet<string>;
  readonly files: ReadonlySet<string>;
}

/** The classes ranked by the claim each makes, the strongest highest. */
export const RANK: Readonly<Record<Confidence, number>> = { certain: 3, probable: 2, possible: 1 };

/** The weaker of two classes, which is a class capped by a ceiling. */
export function capped(found: Confidence, ceiling: Confidence): Confidence {
  return RANK[found] <= RANK[ceiling] ? found : ceiling;
}

/** A value computed on its first read. */
function once<T>(compute: () => T): () => T {
  let held: { readonly value: T } | undefined;
  return () => (held ??= { value: compute() }).value;
}

const BUILT = new WeakMap<EmitterInput, Subjects>();

/** The subject index of one run, built on the first read and shared by every later one. */
export function subjectsOf(input: EmitterInput): Subjects {
  const known = BUILT.get(input);
  if (known !== undefined) {
    return known;
  }
  const union = input.swept.matrix.union;
  const symbols = new Map(union.symbols.map((symbol) => [symbol.id, symbol]));
  const candidates = new Map(
    input.swept.sweep.candidates.map((candidate) => [candidate.id, candidate]),
  );
  const published = new Set(
    union.rooted
      .filter((root) => root.kind === "published-api")
      .flatMap((root) => union.symbols[root.at]?.id ?? []),
  );
  const dead = new Set(candidates.keys());
  const classOf = reachabilityClasses(input, union, published, dead);
  const namedBy = once(() => typeParameterNamers(input, symbols));
  const built: Subjects = {
    input,
    union,
    symbol: (id) => symbols.get(id),
    candidate: (id) => candidates.get(id),
    dead,
    namedBy,
    published,
    visibility: once(() => visibilityOf(union)),
    written: once(() => writtenOf(input, candidates, classOf)),
    files: once(() => keptFiles(input, dead)),
    brands: once(() => brandMembers(input, namedBy())),
    classOf,
    testCeiling: testCeilings(input, classOf),
    testUsed: once(() => testUsedSubjects(input)),
  };
  BUILT.set(input, built);
  return built;
}

/**
 * Folds the run's references into the reach of each declaration. A reference reaches the
 * file that holds the declaration that makes it. A reference from a declaration the
 * inventory does not hold is made by a consumer, and one from a re-export a manifest export
 * reaches stands for every consumer importing the name it publishes; either reaches outside
 * the package.
 */
function visibilityOf(graph: Graph): Visibility {
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
  return { fileOf, rootedBy, published, named, reach };
}

/**
 * Whether one declaration is a subject of the write-only kind: a module-level variable,
 * a member of an object type, or a class member that is state rather than code. A getter
 * or a setter is code, so a store into one runs it.
 */
function writable(input: EmitterInput, symbol: InventorySymbol): boolean {
  if (symbol.kind === "variable" || symbol.kind === "type-member") {
    return true;
  }
  return symbol.kind === "class-member" && !input.stores.accessors.has(symbol.id);
}

/**
 * The kinds of declaration that fall with a write-only subject: a declaration of its own.
 * A member falls with its container, and a type parameter is the type-parameter clause's.
 */
const FALLING: ReadonlySet<SymbolKind> = new Set([
  "function",
  "class",
  "interface",
  "type",
  "enum",
  "namespace",
  "variable",
]);

/**
 * `DS1301`'s subjects: a module-level variable, a type member or a class member the
 * counted references store into and never read. The subject is a live declaration: a store
 * is a reference, so the sweep holds a written one live and its candidates are never this
 * kind's. Every reference that is not a store reads, and so does an exemption record
 * naming the declaration.
 */
function writtenOf(
  input: EmitterInput,
  candidates: ReadonlyMap<string, Candidate>,
  classOf: (id: string) => Confidence,
): Written {
  const { stores } = input;
  const { matrix, sweep } = input.swept;
  const uses = new Map<string, Uses>();
  for (const reference of stores.references) {
    let held = uses.get(reference.to);
    if (held === undefined) {
      held = { writes: [], reads: 0, alone: new Set() };
      uses.set(reference.to, held);
    }
    // A consumer's store is written at a position no report of the target can name, so
    // it counts as a use that keeps the declaration from this kind.
    if (reference.use !== "write" || reference.consumer !== undefined) {
      held.reads += 1;
      continue;
    }
    for (const name of reference.alone ?? []) {
      held.alone.add(name);
    }
    const at = reference.position;
    const key = positionKey(at);
    if (!held.writes.some((written) => positionKey(written) === key)) {
      held.writes.push({ path: at.path, line: at.line, column: at.column, endLine: at.line });
    }
  }

  const subjects = matrix.union.symbols.flatMap((symbol): WrittenSubject[] => {
    const held = uses.get(symbol.id);
    return held === undefined ||
      held.writes.length === 0 ||
      held.reads > 0 ||
      !writable(input, symbol) ||
      stores.exempt.has(symbol.id) ||
      candidates.has(symbol.id)
      ? []
      : [{ symbol, held }];
  });
  const ids = new Set(subjects.map((subject) => subject.symbol.id));
  const named = new Map<string, string[]>();
  const falls = new Set<string>();
  for (const symbol of matrix.union.symbols) {
    const chains = sweep.carried.get(symbol.id);
    if (
      chains === undefined ||
      ids.has(symbol.id) ||
      !FALLING.has(symbol.kind) ||
      classOf(symbol.id) !== "certain"
    ) {
      continue;
    }
    const innermost = chains.map((chain) => chain.find((id) => ids.has(id)));
    if (innermost.includes(undefined)) {
      continue;
    }
    falls.add(symbol.id);
    for (const subject of new Set(innermost)) {
      named.set(subject ?? "", [...(named.get(subject ?? "") ?? []), symbol.id]);
    }
  }
  const keys = new Set(
    subjects.map(({ symbol }) => declarationKey(symbol.ref, symbol.position.path)),
  );
  return { subjects, keys, named, falls };
}

/** Per type parameter, the declarations whose references name it. */
function typeParameterNamers(
  input: EmitterInput,
  symbols: ReadonlyMap<string, InventorySymbol>,
): ReadonlyMap<string, ReadonlySet<string>> {
  const namedBy = new Map<string, Set<string>>();
  for (const reference of input.stores.references) {
    if (symbols.get(reference.to)?.kind === "type-parameter") {
      namedBy.set(reference.to, (namedBy.get(reference.to) ?? new Set()).add(reference.from));
    }
  }
  return namedBy;
}

/** The subject kind of a finding about a source file. */
const FILE_SUBJECT = "file";

/**
 * The paths of the files a reference from a live declaration of another file reaches, a
 * loaded consumer's file included, a root names, or a declared edge names a declaration in,
 * and of every file a reference written anywhere reaches. A file holding a declaration the
 * sweep judged live is kept whatever held it live, and so is a file a program holds by
 * inclusion, which acts on every file of the program without an import naming it. A
 * reference from a file's top level counts once the file is kept.
 */
function keptFiles({ swept, files, boundary }: EmitterInput, dead: ReadonlySet<string>): KeptFiles {
  const union = swept.matrix.union;
  const edgeNamed = new Set(boundary.edges.map((side) => side.symbol));
  const kept = new Set(files.heldByInclusion);
  const referenced = new Set<string>();
  for (const edge of union.consumed) {
    const to = union.symbols[edge.to];
    if (to !== undefined) {
      kept.add(to.position.path);
    }
  }
  for (const root of union.rooted) {
    const named = union.symbols[root.at];
    if (named !== undefined) {
      kept.add(named.position.path);
    }
  }
  for (const symbol of union.symbols) {
    if ((symbol.kind !== FILE_SUBJECT && !dead.has(symbol.id)) || edgeNamed.has(symbol.ref)) {
      kept.add(symbol.position.path);
    }
  }
  const fromTopLevel = new Map<string, string[]>();
  const pending: string[] = [];
  const keep = (path: string): void => {
    if (!kept.has(path)) {
      kept.add(path);
      pending.push(path);
    }
  };
  union.out.forEach((edges, from) => {
    const source = union.symbols[from];
    if (source === undefined) {
      return;
    }
    for (const edge of edges) {
      const to = union.symbols[edge.to]?.position.path;
      if (to === undefined || to === source.position.path) {
        continue;
      }
      referenced.add(to);
      if (source.kind === FILE_SUBJECT) {
        fromTopLevel.set(source.position.path, [
          ...(fromTopLevel.get(source.position.path) ?? []),
          to,
        ]);
      } else if (!dead.has(source.id)) {
        pending.push(to);
      }
    }
  });
  pending.push(...kept);
  for (let path = pending.pop(); path !== undefined; path = pending.pop()) {
    kept.add(path);
    for (const to of fromTopLevel.get(path) ?? []) {
      keep(to);
    }
    fromTopLevel.delete(path);
  }
  return { kept, referenced };
}

/** The kinds of member a brand is: a data member of a type or of a class. */
const BRANDS: ReadonlySet<SymbolKind> = new Set(["type-member", "class-member"]);

/**
 * The members nothing writes or reads that are brands: each names a type parameter of
 * its declaring type that no other part of the declaration names, other than another
 * such member. They are what make two instantiations of the type distinct types, so
 * deleting them would let one instantiation stand for another.
 */
function brandMembers(
  input: EmitterInput,
  namedBy: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlySet<string> {
  const union = input.swept.matrix.union;
  const unreferenced = new Set(
    input.swept.sweep.candidates
      .filter((candidate) => candidate.productionRefs + candidate.testRefs === 0)
      .map((candidate) => candidate.id),
  );
  const brands = new Set<string>();
  for (const [parameter, from] of namedBy) {
    const owner = union.symbols[union.at(parameter)]?.parent;
    const members = [...from].map((id) => union.symbols[union.at(id)]);
    if (
      members.every(
        (member) =>
          member !== undefined &&
          member.parent === owner &&
          BRANDS.has(member.kind) &&
          unreferenced.has(member.id),
      )
    ) {
      for (const member of members) {
        if (member !== undefined) {
          brands.add(member.id);
        }
      }
    }
  }
  return brands;
}

/** The member kinds an object property can declare, which an `in` expression tests by name. */
const IN_TESTED: ReadonlySet<SymbolKind> = new Set([
  "class-member",
  "method",
  "type-member",
  "interface-method",
]);

/**
 * The members whose name an `in` expression of a production file tests by a literal: a
 * value narrowed that way is read back by the name, which no type links to the member.
 */
function testedByIn(input: EmitterInput, union: Graph): ReadonlySet<string> {
  const names = input.files.inOperands ?? new Set<string>();
  if (names.size === 0) {
    return names;
  }
  return new Set(
    union.symbols.flatMap((symbol, at) => {
      const parent = union.symbols[union.parent[at] ?? OUTSIDE];
      return IN_TESTED.has(symbol.kind) &&
        parent !== undefined &&
        symbol.name.startsWith(`${parent.name}.`) &&
        names.has(symbol.name.slice(parent.name.length + 1))
        ? [symbol.id]
        : [];
    }),
  );
}

/**
 * What only a bundler's retry of an import Node leaves unresolved names (program.38), and each
 * dead declaration that reaches through dead declarations, as confidence.20 reads what only
 * tests reach: each is dead only while no loader the analysis does not see loads the file.
 */
function possiblyLoaded(
  input: EmitterInput,
  union: Graph,
  dead: ReadonlySet<string>,
): ReadonlySet<string> {
  const seeds = input.boundary.possiblyLoaded ?? new Set<string>();
  if (seeds.size === 0) {
    return seeds;
  }
  const reached = new Set<string>();
  const pending = union.symbols.flatMap((symbol, at) => (seeds.has(symbol.id) ? [at] : []));
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const symbol = union.symbols[at];
    if (symbol === undefined || reached.has(symbol.id)) {
      continue;
    }
    reached.add(symbol.id);
    for (const edge of union.out[at] ?? []) {
      const to = union.symbols[edge.to];
      if (to !== undefined && dead.has(to.id)) {
        pending.push(edge.to);
      }
    }
  }
  return reached;
}

/**
 * The reachability class of one declaration of the run. A declaration of a library's
 * published API, a public member of a published type included, is `certain` where the
 * run loaded every consumer the scope declared and declared one, `probable` where one did
 * not load, and `possible` where it declared none, whatever the configuration says of the
 * consumer set. A member an `in` expression tests by name, one a function outside the
 * analysis fills, and one {@link possiblyLoaded} names, is `possible`.
 */
function reachabilityClasses(
  input: EmitterInput,
  union: Graph,
  published: ReadonlySet<string>,
  dead: ReadonlySet<string>,
): (id: string) => Confidence {
  const tested = testedByIn(input, union);
  const filled = input.boundary.filledOutside ?? new Set<string>();
  const possible = possiblyLoaded(input, union, dead);
  const { declared, loaded } = input.boundary.consumers;
  const outside: Confidence =
    declared.length === 0
      ? "possible"
      : declared.every((id) => loaded.includes(id))
        ? "certain"
        : "probable";
  return (id) => {
    if (tested.has(id) || filled.has(id) || possible.has(id)) {
      return "possible";
    }
    return published.has(id) ? outside : "certain";
  };
}

/** The target symbols one test of dead code references, by id: production declarations the sweep judges. */
function testTargets(union: Graph, id: string): readonly string[] {
  return (union.out[union.at(id)] ?? []).flatMap((edge) => {
    const target = union.symbols[edge.to];
    const testCode = union.test[edge.to] === true || union.support[edge.to] === true;
    return target !== undefined &&
      !testCode &&
      union.ambient[edge.to] !== true &&
      union.subject[edge.to] === true
      ? [target.id]
      : [];
  });
}

/**
 * The confidence ceiling of a test of dead code: the lowest reachability class among the
 * target symbols it references, because its deadness is theirs, whether or not they share
 * its component. Every other declaration has none below `certain`.
 */
function testCeilings(
  input: EmitterInput,
  classOf: (id: string) => Confidence,
): (id: string) => Confidence {
  const union = input.swept.matrix.union;
  const tests = new Set(
    input.swept.sweep.candidates.filter((one) => one.testOfDeadCode).map((one) => one.id),
  );
  return (id) =>
    tests.has(id)
      ? testTargets(union, id).reduce<Confidence>(
          (lowest, target) => capped(lowest, classOf(target)),
          "certain",
        )
      : "certain";
}

/**
 * The subjects dead only because production code only tests use is: each declaration the
 * sweep marks test-used, each `DS1602` file of such code, and each test of dead code every
 * target of which is one. Nothing they hold references a dead declaration outside them, so
 * the rest of a component they share is reported without them.
 */
function testUsedSubjects(input: EmitterInput): TestUsed {
  const { matrix, sweep } = input.swept;
  const union = matrix.union;
  const used = new Set(sweep.candidates.filter((one) => one.testUsed).map((one) => one.id));
  for (const test of sweep.candidates.filter((one) => one.testOfDeadCode)) {
    const targets = testTargets(union, test.id);
    if (targets.length > 0 && targets.every((target) => used.has(target))) {
      used.add(test.id);
    }
  }
  const files = new Set(
    union.symbols.flatMap((symbol, at) =>
      matrix.testUsed[at] === true ? [symbol.position.path] : [],
    ),
  );
  return { declarations: used, files };
}
