import { CODE } from "../contract/contract.generated.ts";
import type { Finding } from "../finding.ts";
import type { InventorySymbol } from "../inventory.ts";
import type { Candidate } from "../liveness/sweep.ts";
import { codesOf } from "./codes.ts";
import { draft, named, visibilityWord } from "./draft.ts";
import type { Emitter, EmitterInput } from "./emitter.ts";

/** The codes this emitter phrases. */
const FAMILY: ReadonlySet<string> = new Set([
  CODE.unusedExported,
  CODE.unusedUnexported,
  CODE.unusedMember,
  CODE.testOnlyUse,
  CODE.testOfDeadCode,
  CODE.deprecatedUnused,
]);

/**
 * What one finding says: what the subject is, and what the analysis found about its
 * references. A candidate reachability found has references, each from a declaration
 * that is itself dead, so saying it has none would be false.
 */
function messageOf(code: string, candidate: Candidate, symbol: InventorySymbol): string {
  const subject = named(symbol);
  switch (code) {
    case CODE.testOfDeadCode:
      return `${subject} references only target symbols that are reported dead`;
    case CODE.deprecatedUnused:
      return `deprecated ${subject} has no production reference`;
    case CODE.testOnlyUse:
      return testOnlyMessage(candidate, subject);
  }
  const qualified =
    code === CODE.unusedMember
      ? `${visibilityWord(symbol)}${subject}`
      : symbol.kind === "export-alias"
        ? subject
        : `${symbol.exported ? "exported" : "unexported"} ${subject}`;
  if (candidate.relation === "reachability") {
    return `${qualified} is referenced only from declarations that are themselves dead`;
  }
  if (code === CODE.unusedExported) {
    return `${qualified} has no reference in the target and none from any loaded consumer`;
  }
  return `${qualified} has no reference in the target`;
}

/**
 * What a test-only finding says, by what keeps the subject: a test file's name, or only the
 * exemption evidence test files carry, which names nothing (kinds.json, `DS1102`).
 */
function testOnlyMessage(candidate: Candidate, subject: string): string {
  const evidenceOnly = candidate.testRefs > 0 && candidate.testRefs === candidate.testEvidence;
  if (candidate.productionRefs > 0) {
    return evidenceOnly
      ? `${subject} is referenced only from declarations that are themselves dead and kept only by evidence in test files`
      : `${subject} is referenced only from test files and from declarations that are themselves dead`;
  }
  return evidenceOnly
    ? `${subject} is referenced from no file and kept only by evidence in test files`
    : `${subject} is referenced only from test files and never from production code`;
}

/** The findings of the unused-declaration kinds, `DS1001` to `DS1004` and `DS1102` to `DS1104`. */
export const unusedDeclarations: Emitter = (input) => [
  ...familyFindings(input, codesOf(input).dead),
  ...unusedImports(input),
];

/**
 * The import bindings their file never reads. A generated file's are the generator's to
 * remove unless the run includes generated files.
 */
function unusedImports(input: EmitterInput): Finding[] {
  const generated =
    input.config.analysis.generated_files === "include" ? undefined : input.files.generated;
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
export const fallenMembers: Emitter = (input) => familyFindings(input, codesOf(input).fallen);

/** This family's findings over the candidates the codes name, in the sweep's order. */
function familyFindings(input: EmitterInput, codes: ReadonlyMap<string, string>): Finding[] {
  const union = input.swept.matrix.union;
  return input.swept.sweep.candidates.flatMap((candidate) => {
    const code = codes.get(candidate.id);
    const symbol = union.symbols[union.at(candidate.id)];
    return code === undefined || !FAMILY.has(code) || symbol === undefined
      ? []
      : [draft(code, symbol, messageOf(code, candidate, symbol))];
  });
}
