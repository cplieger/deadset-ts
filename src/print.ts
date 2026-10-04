import {
  renderOrigin,
  type Config,
  type DeclarationEntry,
  type Provenance,
  type Provider,
} from "./config.ts";

/** One declaration entry as a document writes it: the members of its shape alone. */
function declarationOf(entry: DeclarationEntry): Record<string, string> {
  switch (entry.shape) {
    case "symbol":
      return { symbol: entry.symbol };
    case "module":
      return { module: entry.module, name: entry.name };
    case "global":
      return { global: entry.global };
  }
}

/** One provider entry as a document writes it: the members of its shape alone. */
function providerOf(entry: Provider): Record<string, unknown> {
  const installed = { name: entry.name, languages: entry.languages, command: entry.command };
  if (entry.shape === "installed") {
    return installed;
  }
  return { ...installed, source: entry.source, version: entry.version, digest: entry.digest };
}

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
      configurations: config.analysis.configurations.map((entry) =>
        entry.shape === "project"
          ? { id: entry.id, project: entry.project }
          : { id: entry.id, os: entry.os, arch: entry.arch, tags: entry.tags },
      ),
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
    providers: { analyzers: config.providers.analyzers.map(providerOf) },
    go: {},
    ts: {
      test_files: config.ts.testFiles,
      entry_files: config.ts.entryFiles,
      component_extensions: config.ts.componentExtensions,
      disabled_conventions: config.ts.disabledConventions,
      injection_registrations: config.ts.injectionRegistrations.map(declarationOf),
      lifecycle_contracts: config.ts.lifecycleContracts.map((entry) => ({
        components: entry.components.map(declarationOf),
        bases: entry.bases.map(declarationOf),
        members: entry.members,
      })),
      serializers: config.ts.serializers.map(declarationOf),
    },
    provenance: Object.fromEntries(
      [...provenance]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([path, origin]) => [path, renderOrigin(origin)]),
    ),
  };
  return `${JSON.stringify(document, undefined, 2)}\n`;
}
