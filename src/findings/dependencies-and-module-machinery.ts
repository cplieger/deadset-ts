import { CODE } from "../contract/contract.generated.ts";
import { declarationKey, type Dependencies } from "../dependencies.ts";
import type { Finding } from "../finding.ts";
import { displayName } from "../inventory.ts";
import { renderRef, type DependencySection } from "../ref.ts";
import type { Emitter, EmitterInput } from "./emitter.ts";
import { subjectsOf } from "./subjects.ts";

/** The words for each section's dependency, as a message names one. */
const SECTION_WORDS: Readonly<Record<DependencySection, string>> = {
  dependency: "dependency",
  "dev-dependency": "development dependency",
  "peer-dependency": "peer dependency",
};

/** How the run judged the declarations and files a dependency's uses may sit in. */
interface DeadCode {
  /** The members of the dead components, and the top level of each file reported unimported. */
  readonly dead: ReadonlySet<string>;
  /** Those found dead under reachability alone. */
  readonly reachedOnly: ReadonlySet<string>;
}

/**
 * The run's dead code: test code keeps the code it references out of every dead component
 * unless that code is dead as well, and a file's top level is dead where no live code
 * reaches the file and no root or edge names it.
 */
function deadCode(input: EmitterInput): DeadCode {
  const { swept } = input;
  const union = swept.matrix.union;
  const dead = new Set(swept.sweep.components.flatMap((component) => component.members));
  const reachedOnly = new Set(
    swept.sweep.candidates.filter((one) => one.relation === "reachability").map((one) => one.id),
  );
  const { kept, referenced } = subjectsOf(input).files();
  for (const symbol of union.symbols) {
    if (symbol.kind === "file" && !kept.has(symbol.position.path)) {
      dead.add(symbol.id);
      if (referenced.has(symbol.position.path)) {
        reachedOnly.add(symbol.id);
      }
    }
  }
  return { dead, reachedOnly };
}

/**
 * A dependency, development dependency or peer dependency of a manifest the run reads
 * that the target does not need, at the position of its key, and one whose every use is
 * held by dead code, which is dead only through that code and falls with its component:
 * at `possible` where one of its holders is published, and found under reachability alone
 * where one of them is.
 */
function unusedDependencies(input: EmitterInput, dependencies: Dependencies): Finding[] {
  const { dead, reachedOnly } = deadCode(input);
  const { published } = subjectsOf(input);
  return dependencies.declared.flatMap((dependency) => {
    const key = declarationKey(dependency);
    const held = dependencies.heldBy.get(key);
    const users = held?.every((id) => dead.has(id)) === true ? held : undefined;
    if (dependencies.ran.has(key) || (dependencies.needed.has(key) && users === undefined)) {
      return [];
    }
    const unbuilt = dependencies.unbuilt.has(dependency.position.path);
    const atPossible = unbuilt || users?.some((id) => published.has(id)) === true;
    // A manifest key can hold a line break, which a display name writes as a space.
    const name = displayName(dependency.name);
    return [
      {
        code: CODE.unusedDependency,
        position: dependency.position,
        symbol: {
          ref: renderRef(dependency.manifest, {
            of: "dependency",
            name: dependency.name,
            section: dependency.section,
          }),
          kind: "dependency",
          name,
          sizeLines: 1,
        },
        message:
          users === undefined
            ? `no import in the target needs the declared ${SECTION_WORDS[dependency.section]} ${name}`
            : `only code that is itself dead uses the declared ${SECTION_WORDS[dependency.section]} ${name}`,
        details: { dependencyClass: dependency.section },
        ...(atPossible ? { reachabilityClass: "possible" as const } : {}),
        ...(users?.some((id) => reachedOnly.has(id)) === true
          ? { unreachableOnly: true as const }
          : {}),
        ...(users === undefined ? {} : { fallsWith: users }),
      },
    ];
  });
}

/** The findings of the dependencies family, `DS1700` to `DS1799`. */
export const dependenciesAndModuleMachinery: Emitter = (input) =>
  unusedDependencies(input, input.dependencies);
