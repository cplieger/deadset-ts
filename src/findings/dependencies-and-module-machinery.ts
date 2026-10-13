import { declarationKey, type Dependencies } from "../dependencies.ts";
import type { Finding } from "../finding.ts";
import { renderRef, type DependencySection } from "../ref.ts";
import type { Emitter, EmitterInput } from "./emitter.ts";
import { nonCodeArtifacts } from "./non-code-artifacts.ts";

const UNUSED_DEPENDENCY = "DS1601";

const FILE_NEVER_IMPORTED = "DS1502";

const MESSAGES: Readonly<Record<DependencySection, string>> = {
  dependency: "no import in the target needs the declared dependency",
  "dev-dependency": "no import in the target needs the declared development dependency",
  "peer-dependency": "no import in the target needs the declared peer dependency",
};

const DEAD_USERS_MESSAGES: Readonly<Record<DependencySection, string>> = {
  dependency: "only code that is itself dead uses the declared dependency",
  "dev-dependency": "only code that is itself dead uses the declared development dependency",
  "peer-dependency": "only code that is itself dead uses the declared peer dependency",
};

/** How the run judged the declarations and files a dependency's uses may sit in. */
interface DeadCode {
  /** The members of the dead components, and the top level of each file reported unimported. */
  readonly dead: ReadonlySet<string>;
  /** Those found dead under reachability alone. */
  readonly reachedOnly: ReadonlySet<string>;
  /** The declarations of a library's published API, whose findings sit at the consumers' class. */
  readonly published: ReadonlySet<string>;
}

/**
 * The run's dead code: test code keeps the code it references out of every dead component
 * unless that code is dead as well, and a file's top level is dead where the file is.
 */
function deadCode(input: EmitterInput): DeadCode {
  const { swept } = input;
  const union = swept.matrix.union;
  const files = new Map(
    union.symbols.filter((one) => one.kind === "file").map((one) => [one.position.path, one.id]),
  );
  const dead = new Set(swept.sweep.components.flatMap((component) => component.members));
  const reachedOnly = new Set(
    swept.sweep.candidates.filter((one) => one.relation === "reachability").map((one) => one.id),
  );
  for (const finding of nonCodeArtifacts(input)) {
    const id = files.get(finding.position.path);
    if (finding.code === FILE_NEVER_IMPORTED && id !== undefined) {
      dead.add(id);
      if (finding.unreachableOnly === true) {
        reachedOnly.add(id);
      }
    }
  }
  const published = new Set(
    union.rooted
      .filter((root) => root.kind === "published-api")
      .flatMap((root) => union.symbols[root.at]?.id ?? []),
  );
  return { dead, reachedOnly, published };
}

/**
 * A dependency, development dependency or peer dependency of a manifest the run reads
 * that the target does not need, at the position of its key, and one whose every use is
 * held by dead code, which is dead only through that code and falls with its component:
 * at `possible` where one of its holders is published, and found under reachability alone
 * where one of them is.
 */
function unusedDependencies(input: EmitterInput, dependencies: Dependencies): Finding[] {
  const { dead, reachedOnly, published } = deadCode(input);
  return dependencies.declared.flatMap((dependency) => {
    const key = declarationKey(dependency);
    const held = dependencies.heldBy.get(key);
    const users = held?.every((id) => dead.has(id)) === true ? held : undefined;
    if (dependencies.ran.has(key) || (dependencies.needed.has(key) && users === undefined)) {
      return [];
    }
    const unbuilt = dependencies.unbuilt.has(dependency.position.path);
    const atPossible = unbuilt || users?.some((id) => published.has(id)) === true;
    return [
      {
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
        message: (users === undefined ? MESSAGES : DEAD_USERS_MESSAGES)[dependency.section],
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

/** The findings of the dependencies-and-module-machinery family, `DS1600` to `DS1699`. */
export const dependenciesAndModuleMachinery: Emitter = (input) =>
  unusedDependencies(input, input.dependencies);
