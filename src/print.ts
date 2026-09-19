import { renderOrigin, type Config, type Provenance } from "./config.ts";

/**
 * The resolved configuration and its provenance as one JSON object, indented,
 * ending in a newline.
 *
 * The output is an instance of the closed key list, so reading it back as a
 * repository configuration resolves to the same configuration: the provenance
 * object is a declared key resolution ignores. Keys are written in the schema's
 * order and the severity and provenance objects in ascending key order, so one
 * configuration renders to one string whatever order a source named its settings
 * in.
 */
export function printConfig(config: Config, provenance: Provenance): string {
  const document = {
    contract_version: config.contractVersion,
    target: { kind: config.targetKind },
    analysis: {
      languages: config.analysis.languages,
      min_confidence: config.analysis.minConfidence,
      generated_files: config.analysis.generatedFiles,
      consumer_tests: config.analysis.consumerTests,
      configurations: config.analysis.configurations.map((entry) => ({
        id: entry.id,
        os: entry.os,
        arch: entry.arch,
        tags: entry.tags,
      })),
      matrix: { complete: config.analysis.matrixComplete },
      template_dirs: config.analysis.templateDirs,
      template_delimiters: {
        left: config.analysis.templateDelimiters.left,
        right: config.analysis.templateDelimiters.right,
      },
    },
    consumers: { complete: config.consumersComplete },
    roots: { patterns: config.rootPatterns },
    severity: Object.fromEntries([...config.severity].sort(([a], [b]) => (a < b ? -1 : 1))),
    exemptions: { disabled: config.exemptionsDisabled },
    reporters: {
      formats: config.reporters.formats,
      sort: config.reporters.sort,
      cascade: config.reporters.cascade,
      max_findings: config.reporters.maxFindings,
      fail_on: config.reporters.failOn,
    },
    go: {},
    ts: {
      test_files: config.ts.testFiles,
      entry_files: config.ts.entryFiles,
    },
    provenance: Object.fromEntries(
      [...provenance]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([path, origin]) => [path, renderOrigin(origin)]),
    ),
  };
  return `${JSON.stringify(document, undefined, 2)}\n`;
}
