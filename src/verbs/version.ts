import { CONTRACT_VERSION, EXIT_CLEAN } from "../contract/contract.generated.ts";
import { type Verb } from "./verb.ts";
import { PRODUCT } from "../product.ts";

/** Writes the version the host reports and the Contract version this analyzer implements. */
export const versionVerb: Verb = ({ out, host }) => {
  out.write(`${PRODUCT} ${host.analyzerVersion()}\ncontract ${CONTRACT_VERSION}\n`);
  return EXIT_CLEAN;
};
