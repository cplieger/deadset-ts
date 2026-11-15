/**
 * What every finding carries beyond what its emitter decides, read from the run and from
 * the code's row of the issue-kind vocabulary: its subject's sweep facts, its component,
 * its confidence, its fixability and its severity.
 */

import { CODE, KIND_ROWS, type KindRow } from "../contract/contract.generated.ts";
import type { CompletedFinding, Finding } from "../finding.ts";
import { OUTSIDE } from "../liveness/graph.ts";
import { KINDS } from "../kinds.ts";
import { positionKey } from "../position.ts";
import { declarationKey } from "../ref.ts";
import { isPartSubject, isRowSubject } from "../suppression/records.ts";
import { claimed, coherent, rootsCeiling } from "./confidence.ts";
import { severityOf } from "./dials.ts";
import { namesSubject } from "./draft.ts";
import type { EmitterInput } from "./emitter.ts";
import { placementOf } from "./placement.ts";
import { subjectsOf } from "./subjects.ts";

/**
 * The codes whose subject the run that counts test references holds live, so a test
 * file's candidate reported under one carries none of a dead declaration's sweep facts.
 */
const LIVE_SUBJECT: ReadonlySet<string> = new Set(
  KIND_ROWS.filter((row) => row.holdsLive).map((row) => row.code),
);

/** The fixability grammar/analysis/fixability.md gives a finding about a held declaration. */
const MANUAL = "manual";

/**
 * Every finding of the run completed, in the order given. A dead declaration carries its
 * candidate's relation, counts, configurations and component; a live one carries no relation and
 * holds where it is declared; a file or a manifest row carries the class its emitter states,
 * `certain` by default, and holds in every configuration. A subject in no dead component gets one
 * of its own, whose deletion removes no line. `kinds` defaults to the shipped vocabulary.
 */
export function completed(
  input: EmitterInput,
  findings: readonly Finding[],
  kinds: ReadonlyMap<string, KindRow> = KINDS,
): readonly CompletedFinding[] {
  const { swept } = input;
  const union = swept.matrix.union;
  const s = subjectsOf(input);
  const positions = new Map(
    union.symbols.map((symbol, at) => [declarationKey(symbol.ref, symbol.position.path), at]),
  );
  const fileIds = new Map(
    union.symbols.flatMap((one) => (one.kind === "file" ? [[one.position.path, one.id]] : [])),
  );
  const testUsed = s.testUsed();
  const placement = placementOf(swept, findings, input.config.reporters.cascade);

  const done = findings.map((finding): CompletedFinding => {
    const row = kinds.get(finding.code);
    if (row === undefined) {
      throw new Error(`${finding.code} names no live row of the issue-kind vocabulary`);
    }
    // An annotation or a SARIF result shows the message with no other name.
    if (!namesSubject(finding.message, finding.symbol.name)) {
      throw new Error(
        `${finding.code} does not name ${finding.symbol.name} in its message: ${finding.message}`,
      );
    }
    // A row's reference may spell a declaration's, as an ignore entry naming one does, and
    // a row is still never the declaration. Two declarations of one file can share a
    // reference, so the one the finding is positioned at is the subject where there is one.
    const declared = union.at(positionKey(finding.position));
    const ref = finding.symbol.holder ?? finding.symbol.ref;
    const at = isRowSubject(finding.symbol.kind)
      ? OUTSIDE
      : union.symbols[declared]?.ref === ref
        ? declared
        : (positions.get(declarationKey(ref, finding.position.path)) ?? OUTSIDE);
    // A part names the declaration that holds it, and is decided inside it rather than by
    // the declaration's liveness, so it carries none of the declaration's sweep facts.
    const part = isPartSubject(finding.symbol.kind);
    const symbol = union.symbols[at];
    const judged = !part && union.subject[at] === true ? symbol : undefined;
    const candidate =
      judged === undefined || LIVE_SUBJECT.has(finding.code) ? undefined : s.candidate(judged.id);
    const fallsWith = finding.fallsWith?.[0];
    const joined = fallsWith === undefined ? undefined : placement.componentOf(fallsWith);
    const file =
      finding.code === CODE.fileNeverImported
        ? placement.files.get(finding.position.path)
        : undefined;
    const found =
      joined !== undefined
        ? { ...joined, root: false }
        : file !== undefined
          ? placement.componentOf(file)
          : symbol === undefined || part
            ? undefined
            : placement.componentOf(symbol.id);
    // A test file's declaration is a component member only as a test of dead code, and
    // test code keeps the test-support code it references out of every component.
    if (
      candidate !== undefined &&
      found === undefined &&
      union.test[at] !== true &&
      candidate.heldByTests === undefined
    ) {
      throw new Error(`${candidate.id} is judged dead and falls in no dead component`);
    }
    const component = found ?? placement.mint(finding, symbol);
    const counts =
      candidate === undefined
        ? union.made[at]
        : { production: candidate.productionRefs, test: candidate.testRefs };
    const configurations =
      candidate?.configurations ??
      (judged === undefined && !part
        ? swept.matrix.configurations
        : (swept.matrix.heldIn[at] ?? swept.matrix.configurations));
    const confidence = claimed({
      own:
        judged !== undefined
          ? s.classOf(judged.id)
          : (finding.reachabilityClass ??
            (finding.code === CODE.fileNeverImported
              ? s.classOf(fileIds.get(finding.position.path) ?? "")
              : "certain")),
      kind: row.maxClass,
      roots: rootsCeiling(
        input,
        candidate?.relation === "reachability" || finding.unreachableOnly === true,
        configurations,
      ),
      tested: judged === undefined ? "certain" : s.testCeiling(judged.id),
      testUsed:
        judged !== undefined
          ? candidate !== undefined && testUsed.declarations.has(judged.id)
          : finding.code === CODE.fileNeverImported && testUsed.files.has(finding.position.path),
      testOfDeadCode: candidate?.testOfDeadCode === true,
    });
    const generated = input.files.generated?.has(finding.position.path) === true;
    const fixability = generated
      ? "none"
      : found !== undefined &&
          symbol !== undefined &&
          placement.held.has(symbol.id) &&
          row.findingFixabilities?.includes(MANUAL) === true
        ? MANUAL
        : row.fixability;
    const lastUses =
      fixability !== "deletable"
        ? undefined
        : candidate !== undefined
          ? input.dependencies.lastUses.get(candidate.id)
          : finding.code === CODE.fileNeverImported
            ? input.dependencies.fileLastUses.get(finding.position.path)
            : undefined;
    return {
      code: finding.code,
      kind: row.name,
      language: "ts",
      position: finding.position,
      symbol: finding.symbol,
      ...confidence,
      ...(candidate === undefined ? {} : { livenessRelation: candidate.relation }),
      ...(finding.fallsWith === undefined ? {} : { fallsWith: finding.fallsWith }),
      testOnly: judged !== undefined && counts?.production === 0 && counts.test > 0,
      generated,
      component,
      retainedBy: [],
      configurations,
      consumersLoaded: input.boundary.consumers.loaded,
      fixability,
      severity: severityOf(input, finding.code, row.defaultSeverity),
      message: finding.message,
      details:
        lastUses === undefined
          ? (finding.details ?? {})
          : { ...finding.details, removesLastUseOf: lastUses },
    };
  });
  return coherent(done, placement.dead);
}
