import { CODE } from "../contract/contract.generated.ts";
import type { Finding, PositionedSymbol } from "../finding.ts";
import type { InventorySymbol } from "../inventory.ts";
import type { Candidate } from "../liveness/sweep.ts";
import { byPosition } from "../position.ts";
import { codesOf } from "./codes.ts";
import { draft, named, positionOf } from "./draft.ts";
import type { Emitter } from "./emitter.ts";
import { subjectsOf, type Subjects } from "./subjects.ts";

/** The classes implementing one interface, positioned and in site order. */
function implementationsOf(s: Subjects, id: string): readonly PositionedSymbol[] {
  return [...(s.input.implementations.classes.get(id) ?? [])]
    .map(s.symbol)
    .filter((symbol): symbol is InventorySymbol => symbol !== undefined)
    .map((symbol) => ({ ref: symbol.ref, name: symbol.name, position: positionOf(symbol) }))
    .sort((a, b) => byPosition(a.position, b.position));
}

/**
 * The findings of the interfaces family, `DS1200` to `DS1299`: `DS1201`, a dead
 * interface, whose members fall with it unreported; and `DS1202`, a method of a live
 * interface no reference names, unless it is a marker, a method whose every
 * implementation has an empty body. A test file's declaration is neither kind's subject,
 * because a production sweep counts none of the references it can have, save an interface
 * the run that counts test references does not reach, which is `DS1201`'s.
 */
export const interfaces: Emitter = (input) => {
  const codes = codesOf(input).dead;
  const s = subjectsOf(input);
  return input.swept.sweep.candidates.flatMap((candidate): Finding[] => {
    const code = codes.get(candidate.id);
    const symbol = s.symbol(candidate.id);
    if (symbol === undefined) {
      return [];
    }
    switch (code) {
      case CODE.unusedInterface:
        return [
          draft(code, symbol, unusedMessage(candidate, named(symbol)), {
            implementations: implementationsOf(s, candidate.id),
          }),
        ];
      case CODE.uncalledInterfaceMethod:
        return [
          draft(
            code,
            symbol,
            `no call site invokes or selects ${named(symbol)} through the interface`,
            {
              implementations: implementationsOf(s, symbol.parent),
            },
          ),
        ];
      default:
        return [];
    }
  });
};

/** What one unused interface's finding says, by the references the sweep counted. */
function unusedMessage(candidate: Candidate, subject: string): string {
  if (candidate.relation === "reachability") {
    return `${subject} is named as a type only from declarations that are themselves dead`;
  }
  return candidate.testRefs > 0 && candidate.productionRefs === 0
    ? `${subject} is named as a type only from test files`
    : `nothing in the target names ${subject} as a type`;
}
