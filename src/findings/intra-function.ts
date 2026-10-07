import type { Finding } from "../finding.ts";
import { KINDS } from "../kinds.ts";
import { UNUSED_PARAMETER, UNUSED_RESULT, type PartFact } from "../intra-function-parts.ts";
import { reachedWithTheTests } from "../sweep.ts";
import type { Emitter, EmitterInput } from "./emitter.ts";

/** A list of rules as a sentence names them. */
function spelled(rules: readonly string[]): string {
  if (rules.length < 2) {
    return rules.join("");
  }
  return `${rules.slice(0, -1).join(", ")} and ${rules.at(-1) ?? ""}`;
}

/** The clause a message ends with: the other rules that report the kind, or that none is known. */
function overlapClause(overlap: readonly string[]): string {
  return overlap.length === 1 && overlap[0] === "none known"
    ? "no other rule is known to report it"
    : `also reported by ${spelled(overlap)}`;
}

/**
 * Whether one parameter's name is reported: every unread one of a function whose
 * signature is free, and of a function used as a value only one no read parameter follows,
 * because a caller may pass such a function more arguments than it declares.
 */
function parameterReported(
  part: PartFact,
  free: ReadonlySet<string>,
  freeButValued: ReadonlySet<string>,
): boolean {
  const place = part.parameter;
  if (place?.inValue !== true && free.has(part.declaration)) {
    return true;
  }
  const valued = place?.inValue === true || freeButValued.has(part.declaration);
  return valued && place?.beforeARead !== true;
}

/**
 * Whether one part is reported. A parameter needs its function's signature free to
 * change; a result needs that, every call in the loaded program to discard it, and every
 * call site to be in the loaded program, so a function with a root or one a module
 * exports to callers the run cannot see has no result to report. Every other part is
 * reported wherever no project found it in use.
 */
function reported(
  input: EmitterInput,
  part: PartFact,
  callersUnknown: ReadonlySet<string>,
): boolean {
  if (part.used) {
    return false;
  }
  const { free, freeButValued, discardedEverywhere } = input.intraFunction;
  switch (part.code) {
    case UNUSED_PARAMETER:
      return parameterReported(part, free, freeButValued);
    case UNUSED_RESULT:
      return (
        free.has(part.declaration) &&
        discardedEverywhere.has(part.declaration) &&
        !callersUnknown.has(part.declaration)
      );
    default:
      return true;
  }
}

/**
 * The findings of the intra-function family, `DS1800` to `DS1899`, each about a part of
 * the declaration its reference names, at the part's own position, whatever the sweep
 * decided about a production declaration. A part of test code is reported only where the
 * run that counts test references reaches its declaration and that is no test of dead
 * code. Each message and the finding's details name the other rules that report the kind.
 */
export const intraFunction: Emitter = (input) => {
  const union = input.swept.matrix.union;
  const byId = new Map(union.symbols.map((symbol) => [symbol.id, symbol]));
  const reached = reachedWithTheTests(union, [
    ...input.swept.exempt.map((record) => record.id),
    ...input.swept.heldByUnanswered,
  ]);
  const testsOfDeadCode = new Set(
    input.swept.sweep.candidates.filter((one) => one.testOfDeadCode).map((one) => one.id),
  );
  const judged = (id: string): boolean => {
    const at = union.at(id);
    const testCode = union.test[at] === true || union.support[at] === true;
    return !testCode || (reached[at] === true && !testsOfDeadCode.has(id));
  };
  const unknown = new Set(
    union.rooted.flatMap((root) => {
      const symbol = union.symbols[root.at];
      return symbol === undefined ? [] : [symbol.id];
    }),
  );
  const { declared, loaded } = input.boundary.consumers;
  const closed = input.config.consumersComplete && declared.every((id) => loaded.includes(id));
  const published = (id: string): boolean => {
    const symbol = byId.get(id);
    return (
      symbol !== undefined &&
      symbol.kind !== "file" &&
      (symbol.exported || published(symbol.parent))
    );
  };
  if (!closed) {
    for (const part of input.intraFunction.parts) {
      if (published(part.declaration)) {
        unknown.add(part.declaration);
      }
    }
  }
  const found: Finding[] = [];
  for (const part of input.intraFunction.parts) {
    const declaration = byId.get(part.declaration);
    const overlap = KINDS.get(part.code)?.overlap ?? [];
    if (declaration === undefined || !judged(declaration.id) || !reported(input, part, unknown)) {
      continue;
    }
    found.push({
      code: part.code,
      position: part.position,
      symbol: {
        ref: declaration.ref,
        kind: part.kind,
        name: part.name,
        sizeLines: part.position.endLine - part.position.line + 1,
      },
      message: `${part.message}; ${overlapClause(overlap)}`,
      details: {
        ...(part.kind === "store" ? { writePositions: [part.position] } : {}),
        overlap,
      },
    });
  }
  return found;
};
