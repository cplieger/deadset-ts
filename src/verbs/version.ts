import { CONTRACT_VERSION } from "../version.ts";
import { EXIT_CLEAN, type Verb } from "./verb.ts";

/** Writes the version the host reports and the Contract version this analyzer implements. */
export const versionVerb: Verb = ({ out, host }) => {
  out.write(`deadset-ts ${host.analyzerVersion()}\ncontract ${CONTRACT_VERSION}\n`);
  return EXIT_CLEAN;
};
