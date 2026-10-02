import { CONFORMANCE, type Conformance } from "../conformance.ts";
import { ANALYZER_NAME, LANGUAGE, SCHEMA_VERSIONS_ACCEPTED } from "../report.ts";
import { CONTRACT_VERSION } from "../version.ts";
import { EXIT_CLEAN, EXIT_FAILURE, EXIT_USAGE, type Verb } from "./verb.ts";

/**
 * The document `describe` writes: the analyzer, the Contract version it implements, the
 * report schema versions it reads, the languages it claims, and its recorded result over
 * the conformance corpus, a member the document omits where no run is recorded.
 */
export function describeDocument(version: string, recorded: Conformance | undefined): string {
  const document = {
    name: ANALYZER_NAME,
    version,
    contract_version: CONTRACT_VERSION,
    schema_versions_accepted: SCHEMA_VERSIONS_ACCEPTED,
    languages: [LANGUAGE],
    ...(recorded === undefined
      ? {}
      : {
          conformance: {
            corpus_version: recorded.corpusVersion,
            result: recorded.result,
            digest: recorded.digest,
          },
        }),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** Writes this analyzer's description to the output stream, and nothing to the error stream. */
export const describeVerb: Verb = ({ out, err, host, args }) => {
  if (args.length > 0) {
    err.write(`deadset-ts: describe takes no argument, got ${JSON.stringify(args[0])}\n`);
    return EXIT_USAGE;
  }
  let version: string;
  try {
    version = host.analyzerVersion();
  } catch (error: unknown) {
    err.write(`deadset-ts: describe: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_FAILURE;
  }
  out.write(describeDocument(version, CONFORMANCE));
  return EXIT_CLEAN;
};
