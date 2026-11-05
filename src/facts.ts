/**
 * The facts document `--facts` writes, `bindings.1` and `bindings.2`: the run's generated
 * files under the one decision the generated-file class reads. It carries no binding
 * record, so it states `evaluated: false`.
 */

import { FACTS_VERSION } from "./contract/contract.generated.ts";
import type { GeneratedFact } from "./generated-file.ts";
import { LANGUAGE, PRODUCT } from "./product.ts";
import { bytewise } from "./text/compare.ts";

/** The facts document of one run, as the text written to the path `--facts` names. */
export function factsDocument(
  version: string,
  generated: ReadonlyMap<string, GeneratedFact>,
): string {
  const document = {
    facts_version: FACTS_VERSION,
    analyzer: { name: PRODUCT, version },
    language: LANGUAGE,
    evaluated: false,
    generated: [...generated]
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
    bindings: [],
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}
