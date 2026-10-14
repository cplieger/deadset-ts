/**
 * What every finding carries beyond what its emitter decides, read from the run and from
 * the code's row of the issue-kind vocabulary, and the dials that withhold a finding
 * together with every finding that falls with a root they withhold.
 */

import type { RunSweep } from "../analysis.ts";
import { componentId, type Component } from "../components.ts";
import { deadComponents } from "../matrix.ts";
import type { Cascade, Confidence, Severity } from "../config.ts";
import type { CompletedFinding, Finding, FindingComponent, PositionedSymbol } from "../finding.ts";
import { OUTSIDE, type Graph } from "../graph.ts";
import type { SymbolKind } from "../inventory.ts";
import { KINDS, type KindRow } from "../kinds.ts";
import { byPosition, positionKey } from "../position.ts";
import { declarationKey } from "../ref.ts";
import { FAMILY_KEY_LENGTH } from "../resolve.ts";
import { isPartSubject, isRowSubject, type Dials } from "../suppress.ts";
import type { Candidate } from "../sweep.ts";
import type { Boundary } from "./boundary.ts";
import type { EmitterInput } from "./emitter.ts";

/** The unused-file code, whose deletion removes every use its file writes. */
const FILE_NEVER_IMPORTED = "DS1502";

/**
 * The codes whose subject the run that counts test references holds live, as
 * finding.schema.json lists them, so a test file's candidate reported under one carries
 * none of a dead declaration's sweep facts.
 */
const LIVE_SUBJECT: ReadonlySet<string> = new Set([
  "DS1101",
  "DS1102",
  "DS1104",
  "DS1204",
  "DS1301",
]);

/** The fixability grammar/analysis.md "Fixability" gives a finding about a held declaration. */
const MANUAL = "manual";

/** The member kinds an object property can declare, which an `in` expression tests by name. */
const IN_TESTED: ReadonlySet<SymbolKind> = new Set([
  "class-member",
  "method",
  "type-member",
  "interface-method",
]);

/** The classes ranked by the claim each makes, the strongest highest. */
const RANK: Readonly<Record<Confidence, number>> = { certain: 3, probable: 2, possible: 1 };

/** The weaker of two classes, which is a class capped by a ceiling. */
function capped(found: Confidence, ceiling: Confidence): Confidence {
  return RANK[found] <= RANK[ceiling] ? found : ceiling;
}

/** Whether the run loaded every consumer the scope declared, which holds of a scope declaring none. */
function everyDeclaredLoaded(boundary: Boundary): boolean {
  const { declared, loaded } = boundary.consumers;
  return declared.every((id) => loaded.includes(id));
}

/**
 * The severity the configuration gives one code: the key naming the code, else the key
 * naming its family, else the code's default.
 */
function severityOf(input: EmitterInput, code: string, fallback: Severity): Severity {
  const { config } = input;
  return (
    config.severity.get(code) ?? config.severity.get(code.slice(0, FAMILY_KEY_LENGTH)) ?? fallback
  );
}

/**
 * The declarations the roots name as a library's published API, each public member of a
 * published type included.
 */
function publishedIds(union: Graph): ReadonlySet<string> {
  return new Set(
    union.rooted
      .filter((root) => root.kind === "published-api")
      .flatMap((root) => union.symbols[root.at]?.id ?? []),
  );
}

/**
 * The members whose name an `in` expression of a production file tests by a literal: a
 * value narrowed that way is read back by the name, which no type links to the member.
 */
function testedByIn(input: EmitterInput): ReadonlySet<string> {
  const names = input.files.inOperands ?? new Set<string>();
  const union = input.swept.matrix.union;
  if (names.size === 0) {
    return names;
  }
  return new Set(
    union.symbols.flatMap((symbol, at) => {
      const parent = union.symbols[union.parent[at] ?? OUTSIDE];
      return IN_TESTED.has(symbol.kind) &&
        parent !== undefined &&
        symbol.name.startsWith(`${parent.name}.`) &&
        names.has(symbol.name.slice(parent.name.length + 1))
        ? [symbol.id]
        : [];
    }),
  );
}

/**
 * The reachability class of one declaration of the run. A declaration of a library's
 * published API, a public member of a published type included, is `certain` where the
 * run loaded every consumer the scope declared and declared one, `probable` where one did
 * not load, and `possible` where it declared none, whatever the configuration says of the
 * consumer set. A member an `in` expression tests by name is `possible`.
 */
function reachabilityClasses(input: EmitterInput): (id: string) => Confidence {
  const tested = testedByIn(input);
  const published = publishedIds(input.swept.matrix.union);
  const { declared } = input.boundary.consumers;
  const outside: Confidence =
    declared.length === 0
      ? "possible"
      : everyDeclaredLoaded(input.boundary)
        ? "certain"
        : "probable";
  return (id) => {
    if (tested.has(id)) {
      return "possible";
    }
    return published.has(id) ? outside : "certain";
  };
}

/** The target symbols one test of dead code references, by id: production declarations the sweep judges. */
function testTargets(union: Graph, id: string): readonly string[] {
  return (union.out[union.at(id)] ?? []).flatMap((edge) => {
    const target = union.symbols[edge.to];
    const testCode = union.test[edge.to] === true || union.support[edge.to] === true;
    return target !== undefined &&
      !testCode &&
      union.ambient[edge.to] !== true &&
      union.subject[edge.to] === true
      ? [target.id]
      : [];
  });
}

/**
 * The confidence ceiling of a test of dead code: the lowest reachability class among the
 * target symbols it references, because its deadness is theirs, whether or not they share
 * its component. Every other declaration has none below `certain`.
 */
function testCeilings(
  input: EmitterInput,
  classOf: (id: string) => Confidence,
): (id: string) => Confidence {
  const union = input.swept.matrix.union;
  const tests = new Set(
    input.swept.sweep.candidates.filter((one) => one.testOfDeadCode).map((one) => one.id),
  );
  return (id) =>
    tests.has(id)
      ? testTargets(union, id).reduce<Confidence>(
          (lowest, target) => capped(lowest, classOf(target)),
          "certain",
        )
      : "certain";
}

/**
 * The subjects dead only because production code only tests use is: each declaration the
 * sweep marks test-used, each `DS1502` file of such code, and each test of dead code every
 * target of which is one. Nothing they hold references a dead declaration outside them, so
 * the rest of a component they share is reported without them.
 */
function testUsedSubjects(input: EmitterInput): {
  readonly declarations: ReadonlySet<string>;
  readonly files: ReadonlySet<string>;
} {
  const { matrix, sweep } = input.swept;
  const union = matrix.union;
  const used = new Set(sweep.candidates.filter((one) => one.testUsed).map((one) => one.id));
  for (const test of sweep.candidates.filter((one) => one.testOfDeadCode)) {
    const targets = testTargets(union, test.id);
    if (targets.length > 0 && targets.every((target) => used.has(target))) {
      used.add(test.id);
    }
  }
  const files = new Set(
    union.symbols.flatMap((symbol, at) =>
      matrix.testUsed[at] === true ? [symbol.position.path] : [],
    ),
  );
  return { declarations: used, files };
}

/**
 * The ceiling the roots the run found put on one dead subject: a subject other declarations
 * reference, found dead only because no root reaches them, is `probable` unless
 * the configuration declares the roots complete, because a root the analysis cannot see
 * would make it live; every other declaration has none below `certain`.
 */
function rootsCeiling(
  input: EmitterInput,
  finding: Finding,
  candidate: Candidate | undefined,
): Confidence {
  const unreachable = candidate?.relation === "reachability" || finding.unreachableOnly === true;
  return unreachable && !input.config.ts.rootsComplete ? "probable" : "certain";
}

/**
 * The component each dead declaration of the run falls in, and none for a live one, with
 * its members listed in the canonical order where the run lists a component in full.
 */
function findingComponents(
  swept: RunSweep,
  components: readonly Component[],
  cascade: Cascade,
): (id: string) => FindingComponent | undefined {
  const held = new Map<string, Component>();
  for (const component of components) {
    for (const member of component.members) {
      held.set(member, component);
    }
  }
  const symbols = new Map(swept.matrix.union.symbols.map((symbol) => [symbol.id, symbol]));
  const listed = (component: Component): readonly PositionedSymbol[] =>
    component.members
      .flatMap((member) => {
        const symbol = symbols.get(member);
        return symbol === undefined
          ? []
          : [
              {
                ref: symbol.ref,
                name: symbol.name,
                position: {
                  ...symbol.position,
                  endLine: Math.max(symbol.position.line, symbol.endLine),
                },
              },
            ];
      })
      .sort((a, b) => byPosition(a.position, b.position));
  return (id) => {
    const component = held.get(id);
    return component === undefined
      ? undefined
      : {
          id: component.id,
          root: component.roots.includes(id),
          symbolCount: component.members.length,
          deletableLines: component.deletableLines,
          ...(cascade === "full" ? { members: listed(component) } : {}),
        };
  };
}

/**
 * The run's dead components with each file a `DS1502` finding reports dead among them, so
 * the file's declarations fall with it, and with the components each subject that is no
 * declaration falls with joined into one.
 */
function runComponents(
  swept: RunSweep,
  findings: readonly Finding[],
): {
  readonly components: readonly Component[];
  readonly computed: number;
  readonly files: ReadonlyMap<string, string>;
} {
  const union = swept.matrix.union;
  const reported = new Set(
    findings.filter((one) => one.code === FILE_NEVER_IMPORTED).map((one) => one.position.path),
  );
  const files = new Map(
    union.symbols.flatMap((symbol, at) =>
      symbol.kind === "file" && reported.has(symbol.position.path) ? [[at, symbol] as const] : [],
    ),
  );
  const computed =
    files.size === 0
      ? swept.sweep.components
      : deadComponents(swept.matrix, swept.sweep, new Set(files.keys()));
  const place = new Map<string, number>();
  computed.forEach((component, at) => {
    for (const member of component.members) {
      place.set(member, at);
    }
  });
  const leader = computed.map((_component, at) => at);
  const find = (at: number): number => {
    let top = at;
    while ((leader[top] ?? top) !== top) {
      top = leader[top] ?? top;
    }
    return top;
  };
  for (const { fallsWith } of findings) {
    const joined = (fallsWith ?? []).flatMap((id) => place.get(id) ?? []).map(find);
    const first = Math.min(...joined);
    for (const one of joined) {
      leader[one] = first;
    }
  }
  const merged = new Map<number, Component>();
  computed.forEach((component, at) => {
    const top = find(at);
    const into = merged.get(top);
    merged.set(
      top,
      into === undefined
        ? component
        : {
            id: into.id,
            members: [...into.members, ...component.members],
            roots: [...into.roots, ...component.roots],
            deletableLines: into.deletableLines + component.deletableLines,
            held: into.held && component.held,
          },
    );
  });
  return {
    components: [...merged.values()],
    computed: computed.length,
    files: new Map([...files.values()].map((symbol) => [symbol.position.path, symbol.id])),
  };
}

/**
 * Every finding of the run completed, in the order given. A dead declaration carries its
 * candidate's relation, counts, configurations and component; a live one carries no relation and
 * holds where it is declared; a file or a manifest row carries the class its emitter states,
 * `certain` by default, and holds in every configuration. A subject in no dead component gets one
 * of its own, numbered past the computed ones in finding order so no two families mint one, whose
 * deletion removes no line. `kinds` defaults to the shipped vocabulary.
 */
export function completed(
  input: EmitterInput,
  findings: readonly Finding[],
  kinds: ReadonlyMap<string, KindRow> = KINDS,
): readonly CompletedFinding[] {
  const { swept } = input;
  const union = swept.matrix.union;
  const positions = new Map(
    union.symbols.map((symbol, at) => [declarationKey(symbol.ref, symbol.position.path), at]),
  );
  const candidates = new Map(swept.sweep.candidates.map((candidate) => [candidate.id, candidate]));
  const classOf = reachabilityClasses(input);
  const ceilingOf = testCeilings(input, classOf);
  const testUsed = testUsedSubjects(input);
  const { components, computed, files } = runComponents(swept, findings);
  const componentOf = findingComponents(swept, components, input.config.reporters.cascade);
  const held = new Set(components.filter((one) => one.held).flatMap((one) => one.members));
  // A join keeps its first component's identifier, so a minted one counts past every computed one.
  let minted = computed;
  const dead = new Set(components.map((component) => component.id));
  const fallingWith = new Map<string, number>();
  for (const { heldByTests } of swept.sweep.candidates) {
    if (heldByTests !== undefined) {
      fallingWith.set(heldByTests, (fallingWith.get(heldByTests) ?? 0) + 1);
    }
  }

  const done = findings.map((finding): CompletedFinding => {
    const row = kinds.get(finding.code);
    if (row === undefined) {
      throw new Error(`${finding.code} names no live row of the issue-kind vocabulary`);
    }
    // A row's reference may spell a declaration's, as an ignore entry naming one does, and
    // a row is still never the declaration. Two declarations of one file can share a
    // reference, so the one the finding is positioned at is the subject where there is one.
    const declared = union.at(positionKey(finding.position));
    const ref = finding.symbol.holder ?? finding.symbol.ref;
    const at = isRowSubject(finding.symbol.kind)
      ? OUTSIDE
      : union.symbols[declared]?.ref === ref
        ? declared
        : (positions.get(declarationKey(ref, finding.position.path)) ?? OUTSIDE);
    // A part names the declaration that holds it, and is decided inside it rather than by
    // the declaration's liveness, so it carries none of the declaration's sweep facts.
    const part = isPartSubject(finding.symbol.kind);
    const symbol = union.symbols[at];
    const judged = !part && union.subject[at] === true ? symbol : undefined;
    const candidate =
      judged === undefined || LIVE_SUBJECT.has(finding.code)
        ? undefined
        : candidates.get(judged.id);
    const fallsWith = finding.fallsWith?.[0];
    const joined = fallsWith === undefined ? undefined : componentOf(fallsWith);
    const file =
      finding.code === FILE_NEVER_IMPORTED ? files.get(finding.position.path) : undefined;
    const found =
      joined !== undefined
        ? { ...joined, root: false }
        : file !== undefined
          ? componentOf(file)
          : symbol === undefined || part
            ? undefined
            : componentOf(symbol.id);
    // A test file's declaration is a component member only as a test of dead code, and
    // test code keeps the test-support code it references out of every component.
    if (
      candidate !== undefined &&
      found === undefined &&
      union.test[at] !== true &&
      candidate.heldByTests === undefined
    ) {
      throw new Error(`${candidate.id} is judged dead and falls in no dead component`);
    }
    let component = found;
    if (component === undefined) {
      minted += 1;
      component = {
        id: componentId(minted),
        root: true,
        symbolCount: symbol?.kind === "interface" ? (fallingWith.get(symbol.id) ?? 1) : 1,
        deletableLines: 0,
      };
    }
    const counts =
      candidate === undefined
        ? union.made[at]
        : { production: candidate.productionRefs, test: candidate.testRefs };
    const ownClass =
      judged === undefined ? (finding.reachabilityClass ?? "certain") : classOf(judged.id);
    const used =
      judged !== undefined
        ? candidate !== undefined && testUsed.declarations.has(judged.id)
        : finding.code === FILE_NEVER_IMPORTED && testUsed.files.has(finding.position.path);
    const reachabilityClass = used && candidate?.testOfDeadCode !== true ? "possible" : ownClass;
    const untested = capped(
      capped(capped(ownClass, row.maxClass), rootsCeiling(input, finding, candidate)),
      judged === undefined ? "certain" : ceilingOf(judged.id),
    );
    const generated = input.files.generated?.has(finding.position.path) === true;
    const fixability = generated
      ? "none"
      : found !== undefined &&
          symbol !== undefined &&
          held.has(symbol.id) &&
          row.findingFixabilities?.includes(MANUAL) === true
        ? MANUAL
        : row.fixability;
    const lastUses =
      fixability !== "deletable"
        ? undefined
        : candidate !== undefined
          ? input.dependencies.lastUses.get(candidate.id)
          : finding.code === FILE_NEVER_IMPORTED
            ? input.dependencies.fileLastUses.get(finding.position.path)
            : undefined;
    return {
      code: finding.code,
      kind: row.name,
      language: "ts",
      position: finding.position,
      symbol: finding.symbol,
      reachabilityClass,
      confidence: used ? "possible" : untested,
      ...(used ? { componentConfidence: untested } : {}),
      ...(candidate === undefined ? {} : { livenessRelation: candidate.relation }),
      testOnly: judged !== undefined && counts?.production === 0 && counts.test > 0,
      generated,
      component,
      retainedBy: [],
      configurations:
        candidate?.configurations ??
        (judged === undefined && !part
          ? swept.matrix.configurations
          : (swept.matrix.heldIn[at] ?? swept.matrix.configurations)),
      consumersLoaded: input.boundary.consumers.loaded,
      fixability,
      severity: severityOf(input, finding.code, row.defaultSeverity),
      message: finding.message,
      details:
        lastUses === undefined
          ? (finding.details ?? {})
          : { ...finding.details, removesLastUseOf: lastUses },
    };
  });
  return componentCapped(done, dead);
}

/**
 * The findings with every finding of a dead component capped by the lowest confidence
 * among the component's root members, so the minimum confidence reports or withholds a
 * component whole but for the findings test-used code lowers on their own.
 */
function componentCapped(
  findings: readonly CompletedFinding[],
  dead: ReadonlySet<string>,
): readonly CompletedFinding[] {
  const lowest = new Map<string, Confidence>();
  for (const finding of findings) {
    const { id, root } = finding.component;
    if (root && dead.has(id)) {
      const held = lowest.get(id);
      const own = componentConfidenceOf(finding);
      lowest.set(id, held === undefined ? own : capped(held, own));
    }
  }
  return findings.map((finding) => {
    const cap = lowest.get(finding.component.id);
    if (cap === undefined) {
      return finding;
    }
    const own = finding.componentConfidence;
    return {
      ...finding,
      confidence: capped(finding.confidence, cap),
      ...(own === undefined ? {} : { componentConfidence: capped(own, cap) }),
    };
  });
}

/** The confidence a finding gives its component's cap and the dials. */
function componentConfidenceOf(finding: CompletedFinding): Confidence {
  return finding.componentConfidence ?? finding.confidence;
}

/** Whether the dials withhold a finding by its own severity or confidence. */
function dialed(
  finding: Pick<CompletedFinding, "severity" | "confidence">,
  minConfidence: Confidence,
): boolean {
  return finding.severity === "allow" || RANK[finding.confidence] < RANK[minConfidence];
}

/**
 * The configuration's dials over one run's completed findings. A finding at `allow` or
 * below the minimum confidence is withheld, and so is every finding of the component of a
 * root the dials withhold, because a symbol that falls with a root is dead only through it
 * and its deletion does not compile while the root stays. A withheld finding that is no
 * root withholds itself alone.
 */
export function dialsOf(
  input: EmitterInput,
  findings: readonly CompletedFinding[],
): Dials<CompletedFinding> {
  const minConfidence = input.config.analysis.minConfidence;
  const components = new Set(
    findings
      .filter(
        (finding) =>
          finding.component.root &&
          dialed({ ...finding, confidence: componentConfidenceOf(finding) }, minConfidence),
      )
      .map((finding) => finding.component.id),
  );
  return {
    allows: (code) => {
      const row = KINDS.get(code);
      return row !== undefined && severityOf(input, code, row.defaultSeverity) === "allow";
    },
    withholds: (finding) => dialed(finding, minConfidence) || components.has(finding.component.id),
  };
}

/** The findings of one run's completed findings that no dial withholds, in the order given. */
export function reportable(
  input: EmitterInput,
  findings: readonly CompletedFinding[],
): readonly CompletedFinding[] {
  const dials = dialsOf(input, findings);
  return findings.filter((finding) => !dials.withholds(finding));
}
