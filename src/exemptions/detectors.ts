/**
 * The exemption classes this analyzer detects, each by its detector, and what their
 * detection reads of the run once for every project. A class without a detector here
 * retains nothing.
 */

import type { ResolvedConfig } from "../config.ts";
import type { Host } from "../host.ts";
import type { Inventory } from "../inventory.ts";
import type { ProjectView } from "../session.ts";
import type { TSExemptionClass } from "./classes.ts";
import { decorator } from "./decorator.ts";
import { enumGroup } from "./enum-group.ts";
import { frameworkLifecycle } from "./framework-lifecycle.ts";
import { generatedFile, type GeneratedFact } from "./generated-file.ts";
import { injectionContainer } from "./injection-container.ts";
import { interfaceSatisfaction } from "./interface-satisfaction.ts";
import { detect, type Detector, type Detectors, type Exemption } from "./lifecycle.ts";
import { reflectiveLookup } from "./reflective-lookup.ts";
import { serializationContract } from "./serialization-contract.ts";
import { readTemplates, templateField } from "./template-field.ts";

export const DETECTORS: Detectors = new Map<TSExemptionClass, Detector>([
  ["interface-satisfaction", interfaceSatisfaction],
  ["enum-group", enumGroup],
  ["generated-file", generatedFile],
  ["template-field", templateField],
  ["reflective-lookup", reflectiveLookup],
  ["decorator", decorator],
  ["injection-container", injectionContainer],
  ["framework-lifecycle", frameworkLifecycle],
  ["serialization-contract", serializationContract],
]);

/** One project, while its view is open, as detection reads it. */
interface DetectedProject<Brand> {
  readonly project: ProjectView<Brand>;
  readonly held: Inventory;
  /** The project's generated files, by path below the target root, each with what decided it. */
  readonly generated: ReadonlyMap<string, GeneratedFact>;
}

/**
 * The detection of one run: what every project's detectors read of the run, read once,
 * and a function that runs them over one project. A switched-off class reads nothing,
 * its templates included, and generated files are held only where the configuration
 * leaves them out of the analysis.
 */
export function detection(
  host: Host,
  targetRoot: string,
  config: ResolvedConfig,
  consumers: readonly string[],
  detectors: Detectors,
): <Brand>(one: DetectedProject<Brand>) => readonly Exemption[] {
  const disabled = new Set(config.exemptions.disabled);
  const templates = disabled.has("template-field")
    ? { delimiters: config.analysis.template_delimiters, files: [] }
    : readTemplates(host, targetRoot, config.analysis);
  const included = config.analysis.generated_files === "include";
  return ({ project, held, generated }) =>
    detect(
      {
        project,
        held,
        targetRoot,
        templates,
        ts: config.ts,
        consumers,
        ...(included ? {} : { generated }),
      },
      detectors,
      disabled,
    );
}
