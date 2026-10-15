import { CODE, type Confidence } from "../contract/contract.generated.ts";
import type { Finding } from "../finding.ts";
import { KINDS } from "../kinds.ts";
import { parameterRef } from "../ref.ts";
import { type PartFact } from "../intra-function-parts.ts";
import { reachedWithTheTests } from "../sweep.ts";
import type { Emitter, EmitterInput } from "./emitter.ts";

/** A list of rules as a sentence names them. */
function spelled(rules: readonly string[]): string {
  if (rules.length < 2) {
    return rules.join("");
  }
  return `${rules.slice(0, -1).join(", ")} and ${rules.at(-1) ?? ""}`;
}

/** The compiler's rule of the parameter kind's overlap list, which reports only in a file it checks. */
const COMPILER_PARAMETER_RULE = "tsc --noUnusedParameters";

/**
 * The clause a message ends with: the other rules that report the part, or that none is
 * known. A parameter of a file the compiler does not check is no report of the compiler's.
 */
function overlapClause(overlap: readonly string[], part: PartFact): string {
  const rules =
    part.parameter?.checked === false
      ? overlap.filter((rule) => rule !== COMPILER_PARAMETER_RULE)
      : overlap;
  return rules.length === 1 && rules[0] === "none known"
    ? "no other rule is known to report it"
    : `also reported by ${spelled(rules)}`;
}

/** What a parameter's finding asks: its deletion, or, where a read parameter follows it, its rename. */
type ParameterVerdict =
  | { readonly fix: "delete"; readonly confidence: Confidence }
  | { readonly fix: "rename" }
  | undefined;

/**
 * Whether one unread parameter is reported, and how. Of a free signature it is deleted. A
 * caller may pass a function used as a value more arguments than it declares, so there one
 * a read parameter follows is renamed to an underscore name, which the compilers read as
 * declared unread, and one no read parameter follows is deleted: kept where the call's
 * inference may read its annotation, at `probable` where nothing reads the annotation or
 * where it is a name a contextually typed object pattern binds.
 */
function parameterVerdict(
  part: PartFact,
  free: ReadonlySet<string>,
  freeButValued: ReadonlySet<string>,
): ParameterVerdict {
  const place = part.parameter;
  if (place?.inValue !== true && free.has(part.declaration)) {
    return place?.annotated === undefined ? { fix: "delete", confidence: "certain" } : undefined;
  }
  const valued = place?.inValue === true || freeButValued.has(part.declaration);
  if (!valued) {
    return undefined;
  }
  if (place?.beforeARead === true) {
    return { fix: "rename" };
  }
  if (place?.annotated === "steers") {
    return undefined;
  }
  const unseen = place?.annotated === "free" || place?.contextualPattern === true;
  return { fix: "delete", confidence: unseen ? "probable" : "certain" };
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
    case CODE.unusedParameter:
      return parameterVerdict(part, free, freeButValued) !== undefined;
    case CODE.unusedResult:
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
 * The findings of the inside-functions family, `DS1401` to `DS1406`, each about a part of
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
    const overlap = KINDS.get(part.code)?.overlap?.ts ?? [];
    if (declaration === undefined || !judged(declaration.id) || !reported(input, part, unknown)) {
      continue;
    }
    const verdict =
      part.code === CODE.unusedParameter
        ? parameterVerdict(part, input.intraFunction.free, input.intraFunction.freeButValued)
        : undefined;
    const message =
      verdict?.fix === "rename"
        ? `${part.message}, and a read parameter follows it, so rename it to _${part.name}`
        : part.message;
    found.push({
      code: part.code,
      position: part.position,
      symbol: {
        ...(part.code === CODE.unusedParameter
          ? { ref: parameterRef(declaration.ref, part.name), holder: declaration.ref }
          : { ref: declaration.ref }),
        kind: part.kind,
        name: part.name,
        sizeLines: part.position.endLine - part.position.line + 1,
      },
      message: `${message}; ${overlapClause(overlap, part)}`,
      details: {
        ...(part.kind === "store" ? { writePositions: [part.position] } : {}),
        overlap,
      },
      ...(verdict?.fix === "delete" && verdict.confidence !== "certain"
        ? { reachabilityClass: verdict.confidence }
        : {}),
    });
  }
  return found;
};
