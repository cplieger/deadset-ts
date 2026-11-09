import { CODE, type Confidence } from "../contract/contract.generated.ts";
import type { Finding } from "../finding.ts";
import { KINDS } from "../kinds.ts";
import { parameterRef } from "../ref.ts";
import type { PartFact, PartKind } from "../intra-function-parts.ts";
import { reachedWithTheTests } from "../liveness/sweep.ts";
import type { Emitter, EmitterInput } from "./emitter.ts";

/** The code each part kind is reported under, and what its finding says before the overlap clause. */
const PART_KINDS: Readonly<Record<PartKind, { code: string; says: (name: string) => string }>> = {
  parameter: {
    code: CODE.unusedParameter,
    says: (name) => `parameter ${name} is never read in the body`,
  },
  result: { code: CODE.unusedResult, says: () => "result is discarded at every call site" },
  store: { code: CODE.deadStore, says: (name) => `value written to ${name} is never read` },
  statement: { code: CODE.unreachableStatement, says: () => "statement is unreachable" },
  case: {
    code: CODE.unreachableCase,
    says: (name) => `case ${name} is covered by an earlier case of the same switch`,
  },
};

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
 * Whether one unread parameter is reported, and how (DS1401's precondition). Of a free
 * signature it is deleted. Of a function used as a value, one a read parameter follows is
 * renamed to an underscore name, and any other is deleted, kept where the call's inference
 * may read its annotation. A deletion is `probable` where an unread annotation or a
 * contextual pattern may matter to the caller, or where `length` counts the parameter of
 * a function used as a value or of a root, whose holder may count it.
 */
function parameterVerdict(
  part: PartFact,
  free: ReadonlySet<string>,
  freeButValued: ReadonlySet<string>,
  rooted: ReadonlySet<string>,
): ParameterVerdict {
  const place = part.parameter;
  const counted = place?.counted === true;
  if (place?.inValue !== true && free.has(part.declaration)) {
    if (place?.annotated !== undefined) {
      return undefined;
    }
    return {
      fix: "delete",
      confidence: counted && rooted.has(part.declaration) ? "probable" : "certain",
    };
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
  const unseen = place?.annotated === "free" || place?.contextualPattern === true || counted;
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
  rooted: ReadonlySet<string>,
  callersUnknown: ReadonlySet<string>,
): boolean {
  const { free, freeButValued, discardedEverywhere } = input.intraFunction;
  switch (part.kind) {
    case "parameter":
      return parameterVerdict(part, free, freeButValued, rooted) !== undefined;
    case "result":
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
    ...input.swept.sweep.exempt.map((record) => record.id),
    ...input.swept.sweep.held,
  ]);
  const testsOfDeadCode = new Set(
    input.swept.sweep.candidates.filter((one) => one.testOfDeadCode).map((one) => one.id),
  );
  const judged = (id: string): boolean => {
    const at = union.at(id);
    const testCode = union.test[at] === true || union.support[at] === true;
    return !testCode || (reached[at] === true && !testsOfDeadCode.has(id));
  };
  const rooted: ReadonlySet<string> = new Set(
    union.rooted.flatMap((root) => {
      const symbol = union.symbols[root.at];
      return symbol === undefined ? [] : [symbol.id];
    }),
  );
  const unknown = new Set(rooted);
  const { declared, loaded } = input.boundary.consumers;
  const closed = input.config.consumers.complete && declared.every((id) => loaded.includes(id));
  if (!closed) {
    for (const id of input.intraFunction.published) {
      unknown.add(id);
    }
  }
  const found: Finding[] = [];
  for (const part of input.intraFunction.parts) {
    const declaration = byId.get(part.declaration);
    const { code, says } = PART_KINDS[part.kind];
    const overlap = KINDS.get(code)?.overlap?.ts ?? [];
    if (
      declaration === undefined ||
      !judged(declaration.id) ||
      !reported(input, part, rooted, unknown)
    ) {
      continue;
    }
    const verdict =
      part.kind === "parameter"
        ? parameterVerdict(
            part,
            input.intraFunction.free,
            input.intraFunction.freeButValued,
            rooted,
          )
        : undefined;
    const message =
      verdict?.fix === "rename"
        ? `${says(part.name)}, and a read parameter follows it, so rename it to _${part.name}`
        : says(part.name);
    found.push({
      code,
      position: part.position,
      symbol: {
        ...(part.kind === "parameter"
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
