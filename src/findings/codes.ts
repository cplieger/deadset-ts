/**
 * Which code each declaration of a run is reported under: one ordered table per
 * population, so a subject carries at most one code, the most specific one. The dead
 * population is the sweep's candidates; the live one is every declaration the sweep holds
 * live, and a test file's declaration only test code references. The family emitters
 * phrase the findings of the codes these tables give their family.
 */

import { CODE } from "../contract/contract.generated.ts";
import type { InventorySymbol, SymbolKind } from "../inventory.ts";
import { OUTSIDE } from "../liveness/graph.ts";
import { runnerCalls, type Candidate } from "../liveness/sweep.ts";
import type { RootKind } from "../roots/root-set.ts";
import { exposedTypes, exposes } from "../exposure.ts";
import { declarationKey } from "../ref.ts";
import type { EmitterInput } from "./emitter.ts";
import { PUBLISHING, publishes, subjectsOf, type Subjects } from "./subjects.ts";

/** The codes a table gives one run's declarations, by declaration id. */
interface Codes {
  /** The code of each candidate the sweep reports on its own. */
  readonly dead: ReadonlyMap<string, string>;
  /** The code of each candidate whose container is dead, as it would be were the container live. */
  readonly fallen: ReadonlyMap<string, string>;
  /** The code of each live declaration. */
  readonly live: ReadonlyMap<string, string>;
}

/** The kinds of declaration that are members of a class, an interface, a type or an enum. */
const MEMBERS: ReadonlySet<SymbolKind> = new Set([
  "method",
  "class-member",
  "type-member",
  "enum-member",
]);

/** The containers whose type parameters `DS1006` reports: a function, a class method and a type alias. */
const SIGNATURES: ReadonlySet<SymbolKind> = new Set(["function", "method", "type"]);

function isSignature(kind: SymbolKind | undefined): boolean {
  return kind !== undefined && SIGNATURES.has(kind);
}

/**
 * The root kinds that name a file without entering it by its exports: a configuration
 * string or a script token runs the file, and no tool reads a name it exports.
 */
const RUN_ONLY: ReadonlySet<RootKind> = new Set<RootKind>(["configuration-string", "script"]);

/**
 * The root kinds whose root of a file enters no export by name: a document's import roots
 * each export it imports, so an export it does not import is judged as in any file.
 */
const PER_NAME: ReadonlySet<RootKind> = new Set<RootKind>(["document-import"]);

/** Whether a root makes its file an entry file, or its declaration an entry, which a tool may read by name. */
function entersByName(kinds: ReadonlySet<RootKind> | undefined): boolean {
  return [...(kinds ?? [])].some((kind) => !PUBLISHING.has(kind) && !RUN_ONLY.has(kind));
}

/**
 * Whether the roots of a declaration's file enter it by name: a test runner's root
 * enters only an export the runner calls, so another export of a test file is judged.
 */
function fileEntersByName(
  kinds: ReadonlySet<RootKind> | undefined,
  symbol: InventorySymbol,
): boolean {
  const entering = [...(kinds ?? [])].filter(
    (kind) => !PUBLISHING.has(kind) && !RUN_ONLY.has(kind) && !PER_NAME.has(kind),
  );
  return (
    entering.some((kind) => kind !== "test-runner") || (entering.length > 0 && runnerCalls(symbol))
  );
}

/** Whether one declaration is a declaration its file's export table names. */
function topLevelExport(s: Subjects, at: number, symbol: InventorySymbol): boolean {
  const parent = s.union.parent[at] ?? OUTSIDE;
  return symbol.exported && parent !== OUTSIDE && s.union.symbols[parent]?.kind === "file";
}

/**
 * Whether an interface method has implementations and every one has an empty body, or is
 * one whose implementations the run could not read in full.
 */
function marker(input: EmitterInput, method: string): boolean {
  if (input.implementations.unknown.has(method)) {
    return true;
  }
  const bodies = [...(input.implementations.bodies.get(method)?.values() ?? [])];
  return bodies.length > 0 && bodies.every((empty) => empty);
}

/**
 * Whether one dead declaration is an unused export no code outside the target can import:
 * the manifest declares `exports` and no root reaches it.
 */
function unreachable(s: Subjects, at: number, symbol: InventorySymbol): boolean {
  return (
    s.input.boundary.encapsulated &&
    topLevelExport(s, at, symbol) &&
    (s.visibility().rootedBy[at]?.size ?? 0) === 0
  );
}

/**
 * The code of a candidate by its shape and its visibility, an unused export nothing
 * outside can import being the unreachable kind's unless only a test file or a test that
 * stays references it, or it is deprecated and production code never references it.
 */
function unreferencedCode(
  s: Subjects,
  candidate: Candidate,
  symbol: InventorySymbol,
  at: number,
): string {
  if (MEMBERS.has(symbol.kind)) {
    return CODE.unusedMember;
  }
  if (!symbol.exported) {
    return CODE.unusedUnexported;
  }
  const yields =
    (candidate.testRefs > 0 && (candidate.productionRefs === 0 || candidate.keptByTests)) ||
    (candidate.productionRefs === 0 && s.input.deprecated.has(symbol.id));
  return unreachable(s, at, symbol) && !yields ? CODE.unreachableExport : CODE.unusedExported;
}

/**
 * The code of the kinds whose own rule reads the declaration's kind and its container:
 * an interface, a method an interface declares, a type parameter and an enum member
 * nothing names. A member of such a container that is itself dead falls with it.
 */
function kindCode(
  s: Subjects,
  candidate: Candidate,
  symbol: InventorySymbol,
  inTest: boolean,
): string | undefined {
  const referenced = candidate.productionRefs + candidate.testRefs > 0;
  const containerDead = s.dead.has(symbol.parent);
  switch (symbol.kind) {
    case "interface":
      return inTest && !candidate.unreferencedTest ? undefined : CODE.unusedInterface;
    case "interface-method":
      return (inTest && !candidate.unreferencedTest) ||
        referenced ||
        containerDead ||
        marker(s.input, candidate.id)
        ? undefined
        : CODE.uncalledInterfaceMethod;
    case "type-parameter":
      return referenced || containerDead || !isSignature(s.symbol(symbol.parent)?.kind)
        ? undefined
        : CODE.unusedTypeParameter;
    case "enum-member":
      return referenced || containerDead ? undefined : CODE.unusedEnumMember;
    default:
      return undefined;
  }
}

/** The kinds {@link kindCode} decides whatever the candidate's references are. */
const KIND_DECIDED: ReadonlySet<SymbolKind> = new Set([
  "file",
  "interface",
  "interface-method",
  "type-parameter",
]);

/**
 * The code one candidate is reported under, or none, each subject once under the most
 * specific code, so no two codes ever name one declaration. `fallen` asks, for a candidate
 * whose container is dead, the code its own finding would carry were the container live,
 * which a record on it is matched against.
 */
function deadCode(s: Subjects, candidate: Candidate, fallen: boolean): string | undefined {
  const at = s.union.at(candidate.id);
  const symbol = s.union.symbols[at];
  if (symbol === undefined) {
    return undefined;
  }
  const inTest = s.union.test[at] === true;
  const ownRule = s.dead.has(symbol.parent) === fallen;
  if (ownRule && candidate.testOfDeadCode) {
    return CODE.testOfDeadCode;
  }
  if (
    KIND_DECIDED.has(symbol.kind) ||
    (symbol.kind === "enum-member" && !referencedBy(candidate))
  ) {
    return fallen ? undefined : kindCode(s, candidate, symbol, inTest);
  }
  if (!ownRule || (inTest && !candidate.unreferencedTest)) {
    return undefined;
  }
  const code = livelessCode(s, candidate, symbol, at);
  return code === CODE.unusedMember && s.brands().has(symbol.id) ? undefined : code;
}

/** Whether a reference of either kind names the candidate. */
function referencedBy(candidate: Candidate): boolean {
  return candidate.productionRefs + candidate.testRefs > 0;
}

/** The code of a candidate of no kind with its own rule, by its references and its shape. */
function livelessCode(
  s: Subjects,
  candidate: Candidate,
  symbol: InventorySymbol,
  at: number,
): string {
  if (candidate.unreferencedTest) {
    return unreferencedCode(s, candidate, symbol, at);
  }
  if (candidate.heldByTests === candidate.id) {
    return CODE.testOnlyUse;
  }
  const deprecated = s.input.deprecated.has(symbol.id);
  if (candidate.productionRefs === 0 && deprecated) {
    return CODE.deprecatedUnused;
  }
  if (
    candidate.testRefs > 0 &&
    (candidate.productionRefs === 0 ||
      (candidate.relation === "reachability" && candidate.keptByTests))
  ) {
    return CODE.testOnlyUse;
  }
  return unreferencedCode(s, candidate, symbol, at);
}

/** What the narrowing kinds read about the run's consumers. */
interface World {
  readonly closed: boolean;
  readonly exposed: ReadonlySet<string> | "every";
}

function worldOf(s: Subjects): World {
  const { input } = s;
  const { declared, loaded } = input.boundary.consumers;
  const closed = input.config.consumers.complete && declared.every((id) => loaded.includes(id));
  const facts = s.visibility();
  return {
    closed,
    exposed: closed
      ? exposedTypes(
          s.union,
          facts.reach.map((reach) => reach === "outside"),
          input.boundary.carriers,
        )
      : new Set<string>(),
  };
}

/**
 * The narrowing code of one live declaration, if one holds: an export of a file, no
 * re-export and none the write-only kind reports, that a reference names and nothing
 * enters by name. Every reference inside its own file makes it a redundant export keyword,
 * where no manifest export reaches the file or the world is closed; references from other
 * files of the package alone make a published one unnecessary when closed.
 */
function narrowingCode(
  s: Subjects,
  world: World,
  at: number,
  symbol: InventorySymbol,
): string | undefined {
  const facts = s.visibility();
  const file = facts.fileOf[at] ?? OUTSIDE;
  if (
    !topLevelExport(s, at, symbol) ||
    s.written().keys.has(declarationKey(symbol.ref, symbol.position.path)) ||
    symbol.kind === "export-alias" ||
    entersByName(facts.rootedBy[at]) ||
    fileEntersByName(facts.rootedBy[file], symbol) ||
    (facts.named[at] ?? 0) === 0
  ) {
    return undefined;
  }
  switch (facts.reach[at]) {
    case "file":
      return facts.published[file] === true && !world.closed
        ? undefined
        : CODE.redundantExportKeyword;
    case "package":
      return !world.closed || !publishes(facts.rootedBy[at]) || exposes(world.exposed, symbol)
        ? undefined
        : CODE.unnecessaryExport;
    default:
      return undefined;
  }
}

const BUILT = new WeakMap<EmitterInput, Codes>();

/**
 * The codes of one run's declarations, computed once. A live declaration is reported under
 * the write-only kind where it is one of its subjects, and otherwise under a narrowing
 * kind; a declaration of a generated file is narrowed only where generated files are
 * included.
 */
export function codesOf(input: EmitterInput): Codes {
  const known = BUILT.get(input);
  if (known !== undefined) {
    return known;
  }
  const s = subjectsOf(input);
  const dead = new Map<string, string>();
  const fallen = new Map<string, string>();
  for (const candidate of input.swept.sweep.candidates) {
    const own = deadCode(s, candidate, false);
    if (own !== undefined) {
      dead.set(candidate.id, own);
    }
    const asLive = deadCode(s, candidate, true);
    if (asLive !== undefined) {
      fallen.set(candidate.id, asLive);
    }
  }
  const live = new Map<string, string>();
  for (const { symbol } of s.written().subjects) {
    live.set(symbol.id, CODE.writeOnlySymbol);
  }
  const world = worldOf(s);
  const generated =
    input.config.analysis.generated_files === "include" ? undefined : input.files.generated;
  s.union.symbols.forEach((symbol, at) => {
    if (live.has(symbol.id) || generated?.has(symbol.position.path) === true) {
      return;
    }
    const candidate = s.candidate(symbol.id);
    // A declaration of test code, a test file's or test-support code's, that only test code
    // references is a candidate, live in the run that counts test references.
    const isLive =
      candidate === undefined ||
      (s.union.test[at] === true && !candidate.unreferencedTest && !candidate.testOfDeadCode);
    if (!isLive) {
      return;
    }
    const code = narrowingCode(s, world, at, symbol);
    if (code !== undefined) {
      live.set(symbol.id, code);
    }
  });
  const codes = { dead, fallen, live };
  BUILT.set(input, codes);
  return codes;
}
