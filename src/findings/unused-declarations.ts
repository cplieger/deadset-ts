import type { Finding } from "../finding.ts";
import type { InventorySymbol, SymbolKind } from "../inventory.ts";
import type { MatrixCandidate } from "../matrix.ts";
import type { Emitter, EmitterInput } from "./emitter.ts";
import { unreachableExports } from "./visibility-narrowing.ts";

/** The kinds of declaration that are members of a class, an interface, a type or an enum. */
const MEMBERS: ReadonlySet<SymbolKind> = new Set([
  "method",
  "class-member",
  "type-member",
  "enum-member",
]);

/**
 * The kinds of declaration no code of this family reports: an interface and a method an
 * interface declares are the interface kinds' subjects, and a type parameter is the
 * subject of the unused-type-parameter kind or of none.
 */
const NOT_THIS_FAMILY: ReadonlySet<SymbolKind> = new Set([
  "file",
  "interface",
  "interface-method",
  "type-parameter",
]);

/** The reader's word for each kind of declaration a finding of the family names. */
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
  /** Whether its container is itself dead, so it falls with the container. */
  readonly containerDead: boolean;
  readonly deprecated: boolean;
  /** Whether the unreachable-export kind reports it. */
  readonly unreachable: boolean;
}

/**
 * The code one candidate is reported under, or none, each symbol once under the most
 * specific code: a test of dead code first; no other test-file declaration, member of a
 * dead container or enum member nothing names; then deprecation, a test reference, and
 * the unreferenced codes, an unimportable unused export being the unreachable kind's.
 */
function codeOf(judged: Judged): string | undefined {
  const { candidate, symbol } = judged;
  if (candidate.testOfDeadCode) {
    return "DS1005";
  }
  if (judged.test || judged.containerDead || NOT_THIS_FAMILY.has(symbol.kind)) {
    return undefined;
  }
  const referenced = candidate.productionRefs + candidate.testRefs > 0;
  if (symbol.kind === "enum-member" && !referenced) {
    return undefined;
  }
  if (candidate.productionRefs === 0 && judged.deprecated) {
    return "DS1006";
  }
  if (candidate.productionRefs === 0 && candidate.testRefs > 0) {
    return "DS1004";
  }
  if (MEMBERS.has(symbol.kind)) {
    return "DS1003";
  }
  if (!symbol.exported) {
    return "DS1002";
  }
  return judged.unreachable ? undefined : "DS1001";
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
    case "DS1005":
      return TEST_OF_DEAD_CODE;
    case "DS1006":
      return `deprecated ${word} has no production reference`;
    case "DS1004":
      return `${word} is referenced only from test files and never from production code`;
  }
  const subject =
    code === "DS1003"
      ? `${visibilityWord(symbol)}${word}`
      : symbol.kind === "export-alias"
        ? word
        : `${symbol.exported ? "exported" : "unexported"} ${word}`;
  if (candidate.relation === "reachability") {
    return `${subject} is referenced only from declarations that are themselves dead`;
  }
  if (code === "DS1001") {
    return `${subject} has no reference in the target and none from any loaded consumer`;
  }
  return `${subject} has no reference in the target`;
}

/** The findings of the unused-declarations family, `DS1000` to `DS1099`. */
export const unusedDeclarations: Emitter = (input) => familyFindings(input, false);

/**
 * The finding each member of a dead container would carry were its container live: what
 * a record on such a member is matched against, since the report carries the container's
 * finding rather than one of the member's own.
 */
export const fallenMembers: Emitter = (input) => familyFindings(input, true);

/** The family's findings, or, where `fallen` is set, its dead containers' members' alone. */
function familyFindings(input: EmitterInput, fallen: boolean): Finding[] {
  const union = input.swept.matrix.union;
  const dead = new Set(input.swept.sweep.candidates.map((candidate) => candidate.id));
  const unreachable = unreachableExports(input);

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
      containerDead: containerDead && !fallen,
      deprecated: input.deprecated.has(symbol.id),
      unreachable: unreachable.has(symbol.id),
    };
    const code = codeOf(judged);
    if (code === undefined) {
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
