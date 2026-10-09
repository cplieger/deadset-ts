import { declarationKey, type Dependencies } from "../dependencies.ts";
import type { Finding } from "../finding.ts";
import { renderRef, type DependencySection } from "../ref.ts";
import type { Emitter } from "./emitter.ts";

const UNUSED_DEPENDENCY = "DS1601";

const MESSAGES: Readonly<Record<DependencySection, string>> = {
  dependency: "no import in the target needs the declared dependency",
  "dev-dependency": "no import in the target needs the declared development dependency",
  "peer-dependency": "no import in the target needs the declared peer dependency",
};

/**
 * A dependency, development dependency or peer dependency of a manifest the run reads
 * that the target does not need, at the position of its key.
 */
function unusedDependencies(dependencies: Dependencies): Finding[] {
  return dependencies.declared
    .filter(
      (dependency) =>
        !dependencies.needed.has(dependency.name) &&
        !dependencies.ran.has(declarationKey(dependency)),
    )
    .map((dependency) => ({
      code: UNUSED_DEPENDENCY,
      position: dependency.position,
      symbol: {
        ref: renderRef(dependency.manifest, {
          of: "dependency",
          name: dependency.name,
          section: dependency.section,
        }),
        kind: "dependency",
        name: dependency.name,
        sizeLines: 1,
      },
      message: MESSAGES[dependency.section],
      details: { dependencyClass: dependency.section },
      ...(dependencies.unbuilt.has(dependency.position.path)
        ? { reachabilityClass: "possible" as const }
        : {}),
    }));
}

/** The findings of the dependencies-and-module-machinery family, `DS1600` to `DS1699`. */
export const dependenciesAndModuleMachinery: Emitter = ({ dependencies }) =>
  unusedDependencies(dependencies);
