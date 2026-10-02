import type { Confidence, Severity } from "../config.ts";
import type { Finding, FindingPosition } from "../finding.ts";
import type { InventorySymbol } from "../inventory.ts";
import type { MatrixCandidate } from "../matrix.ts";
import { positionKey } from "../position.ts";
import type { Relation } from "../sweep.ts";
import {
  findingComponents,
  RANK,
  reachabilityClasses,
  severityOf,
  type FindingComponent,
} from "./completion.ts";
import type { Emitter, EmitterInput } from "./emitter.ts";

/** The codes of this family. */
export type ReadsAndWritesCode = "DS1301" | "DS1302" | "DS1303";

/**
 * Each code's severity where the configuration sets none, as the issue-kind vocabulary
 * states it.
 */
export const DEFAULT_SEVERITY: Readonly<Record<ReadsAndWritesCode, Severity>> = {
  DS1301: "deny",
  DS1302: "deny",
  DS1303: "deny",
};

/** What only some codes carry. */
export interface ReadsAndWritesDetails {
  /** Every position the subject is written at, on `DS1301` alone. */
  readonly writePositions?: readonly FindingPosition[];
}

/** One finding of this family, with every member the family decides. */
export interface ReadsAndWritesFinding extends Finding {
  readonly code: ReadsAndWritesCode;
  readonly reachabilityClass: Confidence;
  readonly confidence: Confidence;
  /** The relation that decided the subject, absent on `DS1301`, whose subject is live. */
  readonly livenessRelation?: Relation;
  /** Whether every reference the run counts to the subject comes from a test file. */
  readonly testOnly: boolean;
  /**
   * The dead component the subject belongs to, absent where it belongs to none: a live
   * subject falls with nothing, and the report gives it a component of its own.
   */
  readonly component?: FindingComponent;
  /** The configurations the finding holds in, in the run's order. */
  readonly configurations: readonly string[];
  readonly severity: Severity;
  readonly details: ReadsAndWritesDetails;
}

/** The containers whose type parameters `DS1303` reports: a function and a class method. */
const SIGNATURES: ReadonlySet<string> = new Set(["function", "method"]);

/** The severity the configuration gives one code of the family. */
function severityIn(input: EmitterInput, code: ReadsAndWritesCode): Severity {
  return severityOf(input.config, code, DEFAULT_SEVERITY[code]);
}

/** What the family reads of one run, indexed by declaration. */
interface Run {
  readonly input: EmitterInput;
  readonly symbols: ReadonlyMap<string, InventorySymbol>;
  readonly candidates: ReadonlyMap<string, MatrixCandidate>;
  readonly componentOf: (id: string) => FindingComponent | undefined;
  readonly classOf: (id: string) => Confidence;
}

function indexed(input: EmitterInput): Run {
  const { matrix, sweep } = input.swept;
  return {
    input,
    symbols: new Map(matrix.union.symbols.map((symbol) => [symbol.id, symbol])),
    candidates: new Map(sweep.candidates.map((candidate) => [candidate.id, candidate])),
    componentOf: findingComponents(input.swept),
    classOf: reachabilityClasses(input.swept),
  };
}

/** Where one declaration is, as a finding states it. */
function positionOf(symbol: InventorySymbol): FindingPosition {
  return {
    path: symbol.position.path,
    line: symbol.position.line,
    column: symbol.position.column,
    endLine: Math.max(symbol.position.line, symbol.endLine),
  };
}

/** The finding about one declaration, every member the family decides filled in. */
function findingAbout(
  run: Run,
  symbol: InventorySymbol,
  code: ReadsAndWritesCode,
  message: string,
  facts: {
    readonly livenessRelation?: Relation;
    readonly testOnly: boolean;
    readonly configurations: readonly string[];
    readonly details: ReadsAndWritesDetails;
  },
): ReadsAndWritesFinding {
  const position = positionOf(symbol);
  const reachabilityClass = run.classOf(symbol.id);
  const component = run.componentOf(symbol.id);
  return {
    code,
    position,
    symbol: {
      ref: symbol.ref,
      kind: symbol.kind,
      name: symbol.name,
      sizeLines: position.endLine - position.line + 1,
    },
    message,
    reachabilityClass,
    confidence: reachabilityClass,
    ...(facts.livenessRelation === undefined ? {} : { livenessRelation: facts.livenessRelation }),
    testOnly: facts.testOnly,
    ...(component === undefined ? {} : { component }),
    configurations: facts.configurations,
    severity: severityIn(run.input, code),
    details: facts.details,
  };
}

/** How one declaration's counted references divide for the write-only kind. */
interface Uses {
  readonly writes: FindingPosition[];
  reads: number;
  production: number;
  test: number;
}

/**
 * Whether one declaration is a subject of the write-only kind: a module-level variable,
 * or a class member that is state rather than code. A getter or a setter is code, so a
 * store into one runs it.
 */
function writable(run: Run, symbol: InventorySymbol): boolean {
  if (symbol.kind === "variable") {
    return true;
  }
  return symbol.kind === "class-member" && !run.input.stores.accessors.has(symbol.id);
}

/**
 * `DS1301`: a module-level variable or a class member the counted references store into
 * and never read, named with every position written.
 *
 * The subject is a live declaration: a store is a reference, so the sweep holds a
 * written one live and its candidates are never this kind's. Every reference that is
 * not a store reads, and so does an exemption record naming the declaration.
 */
function writeOnlySymbols(run: Run): readonly ReadsAndWritesFinding[] {
  const { stores } = run.input;
  const { matrix } = run.input.swept;
  const uses = new Map<string, Uses>();
  for (const reference of stores.references) {
    let held = uses.get(reference.to);
    if (held === undefined) {
      held = { writes: [], reads: 0, production: 0, test: 0 };
      uses.set(reference.to, held);
    }
    if (reference.test) {
      held.test += 1;
    } else {
      held.production += 1;
    }
    if (reference.use !== "write") {
      held.reads += 1;
      continue;
    }
    const at = reference.position;
    const key = positionKey(at);
    if (!held.writes.some((written) => positionKey(written) === key)) {
      held.writes.push({ path: at.path, line: at.line, column: at.column, endLine: at.line });
    }
  }

  const found: ReadsAndWritesFinding[] = [];
  matrix.union.symbols.forEach((symbol, at) => {
    const held = uses.get(symbol.id);
    if (
      held === undefined ||
      held.writes.length === 0 ||
      held.reads > 0 ||
      !writable(run, symbol) ||
      stores.exempt.has(symbol.id) ||
      run.candidates.has(symbol.id)
    ) {
      return;
    }
    const writes = held.writes.length === 1 ? "once" : `at ${String(held.writes.length)} positions`;
    const word = symbol.kind === "variable" ? "variable" : "member";
    found.push(
      findingAbout(
        run,
        symbol,
        "DS1301",
        `${word} ${symbol.name} is written ${writes} and never read`,
        {
          testOnly: held.production === 0 && held.test > 0,
          configurations: matrix.heldIn[at] ?? [],
          details: { writePositions: held.writes },
        },
      ),
    );
  });
  return found;
}

/**
 * The candidates no reference of any file names whose container is not itself dead, of
 * one kind. A reference from a test file alone leaves a candidate to the test-only kind,
 * and a member of a dead container falls with it and is reported inside its component.
 */
function unnamed(
  run: Run,
  kind: InventorySymbol["kind"],
): readonly [MatrixCandidate, InventorySymbol][] {
  return run.input.swept.sweep.candidates.flatMap(
    (candidate): [MatrixCandidate, InventorySymbol][] => {
      const symbol = run.symbols.get(candidate.id);
      if (
        symbol?.kind !== kind ||
        candidate.productionRefs > 0 ||
        candidate.testRefs > 0 ||
        run.candidates.has(symbol.parent)
      ) {
        return [];
      }
      return [[candidate, symbol]];
    },
  );
}

/**
 * `DS1302`: a member of an enum declaration that nothing names. A member an enum-group
 * record holds back is no candidate, so a member a conversion can produce never reaches
 * this kind.
 */
function unusedEnumMembers(run: Run): readonly ReadsAndWritesFinding[] {
  return unnamed(run, "enum-member").map(([candidate, symbol]) =>
    findingAbout(run, symbol, "DS1302", `enum member ${symbol.name} is named nowhere`, {
      livenessRelation: candidate.relation,
      testOnly: false,
      configurations: candidate.configurations,
      details: {},
    }),
  );
}

/**
 * `DS1303`: a type parameter of a function or a class method that neither the
 * declaration's signature nor its body names. A type parameter of a class, an interface,
 * a type alias or a method signature belongs to a type declaration and is never
 * reported, because a phantom parameter makes two instantiations distinct types.
 */
function unusedTypeParameters(run: Run): readonly ReadsAndWritesFinding[] {
  return unnamed(run, "type-parameter")
    .filter(([, symbol]) => SIGNATURES.has(run.symbols.get(symbol.parent)?.kind ?? ""))
    .map(([candidate, symbol]) =>
      findingAbout(
        run,
        symbol,
        "DS1303",
        `type parameter ${symbol.name} is named in neither its signature nor its body`,
        {
          livenessRelation: candidate.relation,
          testOnly: false,
          configurations: candidate.configurations,
          details: {},
        },
      ),
    );
}

/**
 * The references of the declarations the write-only kind reports, whatever the
 * severity: a narrowing kind yields each to it, since deleting the declaration
 * supersedes narrowing it.
 */
export function writeOnlyDeclarations(input: EmitterInput): ReadonlySet<string> {
  return new Set(writeOnlySymbols(indexed(input)).map((finding) => finding.symbol.ref));
}

/** Each code's rule, in code order. */
const RULES: readonly [ReadsAndWritesCode, (run: Run) => readonly ReadsAndWritesFinding[]][] = [
  ["DS1301", writeOnlySymbols],
  ["DS1302", unusedEnumMembers],
  ["DS1303", unusedTypeParameters],
];

/**
 * The findings of the reads-and-writes family, `DS1300` to `DS1399`, each code's in site
 * order. A code the configuration sets to `allow` reports nothing, and a finding whose
 * confidence is below the configured minimum is withheld.
 */
export const readsAndWrites: Emitter = (input) => {
  const run = indexed(input);
  const least = RANK[input.config.analysis.minConfidence];
  return RULES.flatMap(([code, rule]) =>
    severityIn(input, code) === "allow"
      ? []
      : rule(run).filter((finding) => RANK[finding.confidence] >= least),
  );
};
