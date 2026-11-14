/**
 * The facts document `--facts` writes, `bindings.1` and `bindings.2`: the run's generated
 * files under the one decision the generated-file class reads, and the binding records
 * they publish, each consumer with the state the carrier sweep gives it (`bindings.10`,
 * `bindings.16`).
 */

import type { RunAnalysis } from "./analysis.ts";
import { FACTS_VERSION } from "./contract/contract.generated.ts";
import type { BindingRecord } from "./bindings.ts";
import { carry } from "./liveness/carrier.ts";
import { LANGUAGE, PRODUCT } from "./product.ts";
import type { Mode } from "./tests/file-class.ts";
import { bytewise } from "./text/compare.ts";

/** What the run states of the facts beside its analysis. */
interface FactsOptions {
  /** Whether `possible` is at or above `analysis.min_confidence`, so a cap may lower a finding to it. */
  readonly capsAllowed: boolean;
  readonly mode: Mode;
}

/** The binding records of one run with the carrier sweep's state and each consumer's cap. */
function evaluated(analysis: RunAnalysis, options: FactsOptions): readonly BindingRecord[] {
  const { run, swept } = analysis;
  const reached = carry(swept.matrix.union, {
    generated: new Set(run.generated.keys()),
    opaque: run.schema.opaque,
    exempt: swept.sweep.exempt,
    held: swept.sweep.held,
    reads: run.schema.reads,
    members: run.schema.bound.flatMap((one) => one.members),
    memberReads: run.schema.memberReads,
    mode: options.mode,
  });
  const live = new Set<string>();
  for (const bound of run.schema.bound) {
    if (
      bound.ids.some(reached.declaration) ||
      bound.members.some((one) => reached.member(one.key))
    ) {
      live.add(bound.symbol);
    }
  }
  return run.bindings.map((record) => {
    if (record.role !== "consumer") {
      return record;
    }
    const cap = options.capsAllowed ? run.schema.caps.get(record.symbol) : undefined;
    return {
      ...record,
      state: live.has(record.symbol) ? "live" : "unreferenced",
      ...(cap === undefined ? {} : { cap }),
    };
  });
}

/** The facts document of one run, as the text written to the path `--facts` names. */
export function factsDocument(
  version: string,
  analysis: RunAnalysis,
  options: FactsOptions,
): string {
  const document = {
    facts_version: FACTS_VERSION,
    analyzer: { name: PRODUCT, version },
    language: LANGUAGE,
    evaluated: true,
    generated: [...analysis.run.generated]
      .sort(([a], [b]) => bytewise(a, b))
      .map(([path, fact]) => ({
        path,
        line: fact.line,
        evidence: fact.evidence,
        detail: fact.detail,
        ...(fact.generator === undefined
          ? {}
          : {
              generator: {
                row: fact.generator.row,
                ...(fact.generator.version === undefined
                  ? {}
                  : { version: fact.generator.version }),
              },
              schema_files: fact.generator.schemaFiles,
            }),
      })),
    bindings: evaluated(analysis, options),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}
