import { EXIT_CLEAN } from "../contract/contract.generated.ts";
import { printConfig } from "../print.ts";
import { resolve } from "../resolve.ts";
import { type Verb } from "./verb.ts";

/** Writes the resolved configuration with the source of every setting. */
export const printConfigVerb: Verb = ({ out, inputs }) => {
  const { config, provenance } = resolve(inputs());
  out.write(printConfig(config, provenance));
  return EXIT_CLEAN;
};
