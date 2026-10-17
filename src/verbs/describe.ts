import {
  CONTRACT_VERSION,
  EXIT_CLEAN,
  EXIT_USAGE,
  SCHEMA_VERSIONS,
} from "../contract/contract.generated.ts";
import { CONFORMANCE, type Conformance } from "../conformance.ts";
import { type Verb } from "./verb.ts";
import { diagnose, LANGUAGE, PRODUCT } from "../product.ts";
import { ownVersion } from "./version.ts";

/**
 * The document `describe` writes: the analyzer, the Contract version it implements, the
 * report schema versions it reads, the languages it claims, and its recorded result over
 * the conformance corpus, a member the document omits where no run is recorded.
 */
export function describeDocument(version: string, recorded: Conformance | undefined): string {
  const document = {
    name: PRODUCT,
    version,
    contract_version: CONTRACT_VERSION,
    schema_versions_accepted: SCHEMA_VERSIONS,
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

/** Writes this analyzer's description to the output stream. */
export const describeVerb: Verb = ({ out, err, host, args }) => {
  if (args.length > 0) {
    diagnose(err, `describe takes no argument, got ${JSON.stringify(args[0])}`);
    return EXIT_USAGE;
  }
  out.write(describeDocument(ownVersion(host), CONFORMANCE));
  return EXIT_CLEAN;
};
