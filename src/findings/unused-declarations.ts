import { CODE } from "../contract/contract.generated.ts";
import type { Finding } from "../finding.ts";
import type { InventorySymbol, SymbolKind } from "../inventory.ts";
import type { MatrixCandidate } from "../matrix.ts";
import type { Emitter, EmitterInput } from "./emitter.ts";
import { testsUnseenAPI } from "./completion.ts";
import { unreachableExports } from "./visibility-narrowing.ts";

/** The kinds of declaration that are members of a class, an interface, a type or an enum. */
const MEMBERS: ReadonlySet<SymbolKind> = new Set([
  "method",
  "class-member",
  "type-member",
  "enum-member",
]);

/**
 * The kinds of declaration no code of this emitter reports: an interface and a method an
 * interface declares are the interface kinds' subjects, and a type parameter is the
 * subject of the unused-type-parameter kind or of none.
 */
const NOT_REPORTED_HERE: ReadonlySet<SymbolKind> = new Set([
  "file",
  "interface",
  "interface-method",
  "type-parameter",
]);

/** The reader's word for each kind of declaration a finding of this emitter names. */
const WORDS: Readonly<Record<SymbolKind, string>> = {
  file: "file",
  function: "function",
  class: "class",
  interface: "interface",
  type: "type alias",
  enum: "enum",
  namespace: "namespace",
  variable: "variable",
  "export-alias": "re-export",
  method: "method",
  "class-member": "class member",
  "interface-method": "interface method",
  "type-member": "type member",
  "enum-member": "enum member",
  "type-parameter": "type parameter",
};

/** What the test-of-dead-code kind says, which states the rule it applies. */
const TEST_OF_DEAD_CODE = "every target symbol this test references is reported dead";

/** What the run holds about one candidate that decides its code. */
interface Judged {
  readonly candidate: MatrixCandidate;
  readonly symbol: InventorySymbol;
  /** Whether a test file declares it. */
  readonly test: boolean;
  readonly deprecated: boolean;
  /** Whether the unreachable-export kind reports it. */
  readonly unreachable: boolean;
  /** Whether it is a test with a target that is published API no declared consumer judges. */
  readonly testsUnseenAPI: boolean;
}

/**
 * The code one candidate is reported under, or none, each symbol once under the most
 * specific code: a test of dead code first; no other test-file declaration or enum
 * member nothing names; a test-support declaration test code references as test-only
 * use; then deprecation, a test reference, or only dead production references beside a
 * test that stays, and the unreferenced codes, an unimportable unused export being the
 * unreachable kind's.
 */
function codeOf(judged: Judged): string | undefined {
  const { candidate, symbol } = judged;
  if (candidate.testOfDeadCode) {
    return judged.testsUnseenAPI ? undefined : CODE.testOfDeadCode;
  }
  if ((judged.test && !candidate.unreferencedTest) || NOT_REPORTED_HERE.has(symbol.kind)) {
    return undefined;
  }
  const referenced = candidate.productionRefs + candidate.testRefs > 0;
  if (symbol.kind === "enum-member" && !referenced) {
    return undefined;
  }
  if (candidate.unreferencedTest) {
    return unreferencedCode(symbol);
  }
  if (candidate.heldByTests === candidate.id) {
    return CODE.testOnlyUse;
  }
  if (candidate.productionRefs === 0 && judged.deprecated) {
    return CODE.deprecatedUnused;
  }
  if (
    candidate.testRefs > 0 &&
    (candidate.productionRefs === 0 ||
      (candidate.relation === "reachability" && candidate.keptByTests))
  ) {
    return CODE.testOnlyUse;
  }
  if (MEMBERS.has(symbol.kind)) {
    return CODE.unusedMember;
  }
  if (!symbol.exported) {
    return CODE.unusedUnexported;
  }
  return judged.unreachable ? undefined : CODE.unusedExported;
}

/** The code a declaration nothing references carries, by its shape and its visibility. */
function unreferencedCode(symbol: InventorySymbol): string {
  if (MEMBERS.has(symbol.kind)) {
    return CODE.unusedMember;
  }
  return symbol.exported ? CODE.unusedExported : CODE.unusedUnexported;
}

/** The visibility a member's message names, where it narrows the member's reach. */
function visibilityWord(symbol: InventorySymbol): string {
  switch (symbol.visibility) {
    case "private":
    case "private-name":
      return "private ";
    case "protected":
      return "protected ";
    case "public":
      return "";
  }
}

/**
 * What one finding says: what the subject is, and what the analysis found about its
 * references. A candidate reachability found has references, each from a declaration
 * that is itself dead, so saying it has none would be false.
 */
function messageOf(code: string, judged: Judged): string {
  const { candidate, symbol } = judged;
  const word = WORDS[symbol.kind];
  switch (code) {
    case CODE.testOfDeadCode:
      return TEST_OF_DEAD_CODE;
    case CODE.deprecatedUnused:
      return `deprecated ${word} has no production reference`;
    case CODE.testOnlyUse:
      return candidate.productionRefs === 0
        ? `${word} is referenced only from test files and never from production code`
        : `${word} is referenced only from test files and from declarations that are themselves dead`;
  }
  const subject =
    code === CODE.unusedMember
      ? `${visibilityWord(symbol)}${word}`
      : symbol.kind === "export-alias"
        ? word
        : `${symbol.exported ? "exported" : "unexported"} ${word}`;
  if (candidate.relation === "reachability") {
    return `${subject} is referenced only from declarations that are themselves dead`;
  }
  if (code === CODE.unusedExported) {
    return `${subject} has no reference in the target and none from any loaded consumer`;
  }
  return `${subject} has no reference in the target`;
}

/**
 * The members nothing writes or reads that are brands: each names a type parameter of
 * its declaring type that no other part of the declaration names, other than another
 * such member. They are what make two instantiations of the type distinct types, so
 * deleting them would let one instantiation stand for another.
 */
function brandMembers(input: EmitterInput): ReadonlySet<string> {
  const union = input.swept.matrix.union;
  const unreferenced = new Map(
    input.swept.sweep.candidates
      .filter((candidate) => candidate.productionRefs + candidate.testRefs === 0)
      .map((candidate) => [candidate.id, candidate]),
  );
  const namedBy = new Map<string, Set<string>>();
  for (const reference of input.stores.references) {
    const to = union.symbols[union.at(reference.to)];
    if (to?.kind === "type-parameter") {
      namedBy.set(to.id, (namedBy.get(to.id) ?? new Set()).add(reference.from));
    }
  }
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

/** The kinds of member a brand is: a data member of a type or of a class. */
const BRANDS: ReadonlySet<SymbolKind> = new Set(["type-member", "class-member"]);

/** The findings of the unused-declaration kinds, `DS1001` to `DS1004` and `DS1102` to `DS1104`. */
export const unusedDeclarations: Emitter = (input) => [
  ...emitterFindings(input, false),
  ...unusedImports(input),
];

/**
 * The import bindings their file never reads. A generated file's are the generator's to
 * remove unless the run includes generated files.
 */
function unusedImports(input: EmitterInput): Finding[] {
  const generated =
    input.config.analysis.generatedFiles === "include" ? undefined : input.files.generated;
  return input.intraFunction.imports.flatMap((binding) =>
    binding.used || generated?.has(binding.position.path) === true
      ? []
      : [
          {
            code: CODE.unusedImport,
            position: binding.position,
            symbol: { ref: binding.ref, kind: "import", name: binding.name, sizeLines: 1 },
            message: `import binding ${binding.name} is never read in its file`,
          },
        ],
  );
}

/**
 * The finding each member of a dead container would carry were its container live: what
 * a record on such a member is matched against, since the report carries the container's
 * finding rather than one of the member's own.
 */
export const fallenMembers: Emitter = (input) => emitterFindings(input, true);

/** This emitter's findings, or, where `fallen` is set, its dead containers' members' alone. */
function emitterFindings(input: EmitterInput, fallen: boolean): Finding[] {
  const union = input.swept.matrix.union;
  const dead = new Set(input.swept.sweep.candidates.map((candidate) => candidate.id));
  const unreachable = unreachableExports(input);
  const unseenAPI = testsUnseenAPI(input);
  let brands: ReadonlySet<string> | undefined;

  const found: Finding[] = [];
  for (const candidate of input.swept.sweep.candidates) {
    const at = union.at(candidate.id);
    const symbol = union.symbols[at];
    if (symbol === undefined) {
      continue;
    }
    const containerDead = dead.has(symbol.parent);
    if (fallen !== containerDead) {
      continue;
    }
    const judged: Judged = {
      candidate,
      symbol,
      test: union.test[at] === true,
      deprecated: input.deprecated.has(symbol.id),
      unreachable: unreachable.has(symbol.id),
      testsUnseenAPI: candidate.testOfDeadCode && unseenAPI(candidate.id),
    };
    const code = codeOf(judged);
    if (
      code === undefined ||
      (code === CODE.unusedMember && (brands ??= brandMembers(input)).has(symbol.id))
    ) {
      continue;
    }
    const endLine = Math.max(symbol.position.line, symbol.endLine);
    found.push({
      code,
      position: { ...symbol.position, endLine },
      symbol: {
        ref: symbol.ref,
        kind: symbol.kind,
        name: symbol.name,
        sizeLines: endLine - symbol.position.line + 1,
      },
      message: messageOf(code, judged),
    });
  }
  return found;
}
