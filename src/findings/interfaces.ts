import type { Finding, FindingPosition, PositionedSymbol } from "../finding.ts";
import type { InventorySymbol } from "../inventory.ts";
import { byPosition } from "../position.ts";
import type { Candidate } from "../sweep.ts";
import type { Emitter, EmitterInput } from "./emitter.ts";

const UNUSED_INTERFACE = "DS1201";
const UNCALLED_INTERFACE_METHOD = "DS1203";

/** What each finding says, by what the sweep found about the subject's references. */
const UNUSED_MESSAGE = "nothing in the target names the interface as a type";
const UNUSED_DEAD_MESSAGE =
  "the interface is named as a type only from declarations that are themselves dead";
const UNUSED_TEST_MESSAGE = "the interface is named as a type only from test files";
const UNCALLED_MESSAGE = "no call site invokes or selects the method through the interface";

/** Where one declaration is written, as a finding carries it. */
function positionOf(symbol: InventorySymbol): FindingPosition {
  return { ...symbol.position, endLine: Math.max(symbol.position.line, symbol.endLine) };
}

/** Two strings ordered bytewise. */
function compare(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/** One run's declarations and candidates, indexed for the two kinds. */
function indexed(input: EmitterInput): {
  readonly symbolOf: (id: string) => InventorySymbol | undefined;
  readonly inTest: (id: string) => boolean;
  readonly inSupport: (id: string) => boolean;
  readonly candidateOf: (id: string) => Candidate | undefined;
  readonly implementationsOf: (id: string) => readonly PositionedSymbol[];
} {
  const union = input.swept.matrix.union;
  const symbols = new Map(union.symbols.map((symbol) => [symbol.id, symbol]));
  const candidates = new Map(
    input.swept.sweep.candidates.map((candidate) => [candidate.id, candidate]),
  );
  const symbolOf = (id: string): InventorySymbol | undefined => symbols.get(id);
  return {
    symbolOf,
    inTest: (id) => union.test[union.at(id)] === true,
    inSupport: (id) => union.support[union.at(id)] === true,
    candidateOf: (id) => candidates.get(id),
    implementationsOf: (id) =>
      [...(input.implementations.classes.get(id) ?? [])]
        .map(symbolOf)
        .filter((symbol): symbol is InventorySymbol => symbol !== undefined)
        .map((symbol) => ({ ref: symbol.ref, name: symbol.name, position: positionOf(symbol) }))
        .sort((a, b) => byPosition(a.position, b.position) || compare(a.ref, b.ref)),
  };
}

/** The finding one code makes about one declaration. */
function findingOf(
  code: string,
  symbol: InventorySymbol,
  message: string,
  implementations: readonly PositionedSymbol[],
): Finding {
  const position = positionOf(symbol);
  return {
    code,
    position,
    symbol: {
      ref: symbol.ref,
      kind: symbol.kind,
      name: symbol.name,
      sizeLines: position.endLine - position.line + 1,
    },
    message,
    details: { implementations },
  };
}

/**
 * The findings of the interfaces family, `DS1200` to `DS1299`: `DS1201`, a dead
 * interface, whose members fall with it unreported; and `DS1203`, a method of a live
 * interface no reference names, unless it is a marker, a method whose every
 * implementation has an empty body. A test file's declaration is neither kind's
 * subject, because a production sweep counts none of the references it can have, and
 * neither is a test-support declaration test code references, which that code keeps live.
 */
export const interfaces: Emitter = (input) => {
  const run = indexed(input);
  const found: Finding[] = [];
  for (const candidate of input.swept.sweep.candidates) {
    const symbol = run.symbolOf(candidate.id);
    if (
      symbol === undefined ||
      run.inTest(candidate.id) ||
      (run.inSupport(candidate.id) && candidate.testRefs > 0)
    ) {
      continue;
    }
    if (symbol.kind === "interface") {
      found.push(
        findingOf(
          UNUSED_INTERFACE,
          symbol,
          unusedMessage(candidate),
          run.implementationsOf(candidate.id),
        ),
      );
      continue;
    }
    if (
      symbol.kind !== "interface-method" ||
      candidate.productionRefs + candidate.testRefs > 0 ||
      run.candidateOf(symbol.parent) !== undefined ||
      marker(input, candidate.id)
    ) {
      continue;
    }
    found.push(
      findingOf(
        UNCALLED_INTERFACE_METHOD,
        symbol,
        UNCALLED_MESSAGE,
        run.implementationsOf(symbol.parent),
      ),
    );
  }
  return found;
};

/** What one unused interface's finding says, by the references the sweep counted. */
function unusedMessage(candidate: Candidate): string {
  if (candidate.relation === "reachability") {
    return UNUSED_DEAD_MESSAGE;
  }
  return candidate.testRefs > 0 && candidate.productionRefs === 0
    ? UNUSED_TEST_MESSAGE
    : UNUSED_MESSAGE;
}

/**
 * Whether one interface method has implementations and every one has an empty body, or
 * is one whose implementations the run could not read in full.
 */
function marker(input: EmitterInput, method: string): boolean {
  if (input.implementations.unknown.has(method)) {
    return true;
  }
  const bodies = [...(input.implementations.bodies.get(method)?.values() ?? [])];
  return bodies.length > 0 && bodies.every((empty) => empty);
}
