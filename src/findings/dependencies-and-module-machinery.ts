import type { Dependencies } from "../dependencies.ts";
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
 * The dependencies the target needs: every package the projects' uses name, every
 * declared dependency that ships a command, which a script, a workflow or a shell
 * runs outside anything the analysis reads, and every peer a needed package
 * requires, which the target satisfies by declaring it.
 */
function neededBy(dependencies: Dependencies): ReadonlySet<string> {
  const needed = new Set(dependencies.needed);
  for (const [name, installed] of dependencies.installed) {
    if (installed.command) {
      needed.add(name);
    }
  }
  const pending = [...needed];
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    for (const peer of dependencies.installed.get(name)?.peers ?? []) {
      if (!needed.has(peer)) {
        needed.add(peer);
        pending.push(peer);
      }
    }
  }
  return needed;
}

/**
 * A dependency, development dependency or peer dependency of a manifest the run reads
 * that the target does not need, at the position of its key.
 */
function unusedDependencies(dependencies: Dependencies): Finding[] {
  const needed = neededBy(dependencies);
  return dependencies.declared
    .filter((dependency) => !needed.has(dependency.name))
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
    }));
}

/** The findings of the dependencies-and-module-machinery family, `DS1600` to `DS1699`. */
export const dependenciesAndModuleMachinery: Emitter = ({ dependencies }) =>
  unusedDependencies(dependencies);
