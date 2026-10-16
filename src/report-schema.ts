/**
 * Holds a report to `contract/report.schema.json` and `contract/finding.schema.json`
 * before it is written, reading the schemas the generator copies from the Contract, so
 * this analyzer never writes a document a reader refuses.
 */

import { REPORT_SCHEMAS, type Report } from "./contract/report.generated.ts";
import { schemaRefusals, type SchemaRefusal } from "./schema.ts";

const reportSchema = schemaRefusals(REPORT_SCHEMAS, "report.schema.json");

/**
 * What the report schema refuses in one report document, none for an instance, and, as
 * no schema keyword can state it, a components listing that is not one entry per
 * component a finding or an edge evaluation's finding names.
 */
export function reportRefusals(document: unknown): readonly SchemaRefusal[] {
  const found = reportSchema(document);
  return found.length > 0 ? found : listingRefusals(document as Report);
}

/** The components listing held to the components the findings name, once each. */
function listingRefusals(report: Report): readonly SchemaRefusal[] {
  if (report.components === undefined) {
    return [];
  }
  const refuse = (pointer: string, reason: string): SchemaRefusal[] => [
    { pointer, keyword: "components", reason, member: "" },
  ];
  const listed = new Set<string>();
  for (const [i, entry] of report.components.entries()) {
    if (listed.has(entry.id)) {
      return refuse(
        `/components/${String(i)}`,
        `the entry lists component ${entry.id} a second time`,
      );
    }
    listed.add(entry.id);
  }
  const named = [
    ...report.findings.map(
      (finding, i) => [`/findings/${String(i)}`, finding.component.id] as const,
    ),
    ...report.edge_evaluations.flatMap((one, i) =>
      one.finding === undefined
        ? []
        : [[`/edge_evaluations/${String(i)}/finding`, one.finding.component.id] as const],
    ),
  ];
  for (const [pointer, id] of named) {
    if (!listed.has(id)) {
      return refuse(
        pointer,
        `the finding names component ${id}, which the components listing lacks`,
      );
    }
  }
  const ids = new Set(named.map(([, id]) => id));
  for (const [i, entry] of report.components.entries()) {
    if (!ids.has(entry.id)) {
      return refuse(
        `/components/${String(i)}`,
        `the entry lists component ${entry.id}, which no finding names`,
      );
    }
  }
  return [];
}
