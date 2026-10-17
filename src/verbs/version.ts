import { CONTRACT_VERSION, EXIT_CLEAN } from "../contract/contract.generated.ts";
import { productFault } from "../failure.ts";
import type { Host } from "../host.ts";
import { type Verb } from "./verb.ts";
import { message, PRODUCT } from "../product.ts";

/** The version the host reports for this analyzer; one it cannot read is a fault of the analyzer. */
export function ownVersion(host: Host): string {
  try {
    return host.analyzerVersion();
  } catch (error: unknown) {
    throw productFault(`cannot read its own version: ${message(error)}`);
  }
}

/** Writes the version the host reports and the Contract version this analyzer implements. */
export const versionVerb: Verb = ({ out, host }) => {
  out.write(`${PRODUCT} ${ownVersion(host)}\ncontract ${CONTRACT_VERSION}\n`);
  return EXIT_CLEAN;
};
