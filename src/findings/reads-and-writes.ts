import { CODE } from "../contract/contract.generated.ts";
import type { Finding, FindingDetails, FindingPosition } from "../finding.ts";
import { WORDS, type InventorySymbol } from "../inventory.ts";
import type { Candidate } from "../liveness/sweep.ts";
import { positionKey } from "../position.ts";
import { declarationKey } from "../ref.ts";
import { reachabilityClasses } from "./completion.ts";
import type { Emitter, EmitterInput } from "./emitter.ts";

import { bytewise } from "../text/compare.ts";

/** The codes this emitter reports. */
type ReadsAndWritesCode =
  typeof CODE.writeOnlySymbol | typeof CODE.unusedEnumMember | typeof CODE.unusedTypeParameter;

/** The containers whose type parameters `DS1006` reports: a function, a class method and a type alias. */
const SIGNATURES: ReadonlySet<string> = new Set(["function", "method", "type"]);

/** What this emitter reads of one run, indexed by declaration. */
interface Run {
  readonly input: EmitterInput;
  readonly symbols: ReadonlyMap<string, InventorySymbol>;
  readonly candidates: ReadonlyMap<string, Candidate>;
}

function indexed(input: EmitterInput): Run {
  const { matrix, sweep } = input.swept;
  return {
    input,
    symbols: new Map(matrix.union.symbols.map((symbol) => [symbol.id, symbol])),
    candidates: new Map(sweep.candidates.map((candidate) => [candidate.id, candidate])),
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

/** The finding one code makes about one declaration. */
function findingAbout(
  symbol: InventorySymbol,
  code: ReadsAndWritesCode,
  message: string,
  details?: FindingDetails,
): Finding {
  const position = positionOf(symbol);
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
    ...(details === undefined ? {} : { details }),
  };
}

/** How one declaration's counted references divide for the write-only kind. */
interface Uses {
  readonly writes: FindingPosition[];
  reads: number;
  /** The import bindings only the writes use. */
  readonly alone: Set<string>;
}

/**
 * Whether one declaration is a subject of the write-only kind: a module-level variable,
 * a member of an object type, or a class member that is state rather than code. A getter
 * or a setter is code, so a store into one runs it.
 */
function writable(run: Run, symbol: InventorySymbol): boolean {
  if (symbol.kind === "variable" || symbol.kind === "type-member") {
    return true;
  }
  return symbol.kind === "class-member" && !run.input.stores.accessors.has(symbol.id);
}

/** The reader's word for each kind of the write-only kind's subject. */
const SUBJECT_WORDS: Readonly<Partial<Record<InventorySymbol["kind"], string>>> = {
  variable: "variable",
  "class-member": "member",
  "type-member": "type member",
};

/**
 * The type parameters of one member's declaring type that only the member names, which
 * deleting the member leaves unused.
 */
function parametersOnlyNamedBy(
  run: Run,
  namedBy: ReadonlyMap<string, ReadonlySet<string>>,
  member: InventorySymbol,
): readonly string[] {
  return [...run.symbols.values()]
    .filter((symbol) => {
      const from = namedBy.get(symbol.id);
      return (
        symbol.kind === "type-parameter" &&
        symbol.parent === member.parent &&
        from?.size === 1 &&
        from.has(member.id)
      );
    })
    .map((symbol) => symbol.name);
}

/** What one write-only finding says, the declarations its deletion takes with it included. */
function writeOnlyMessage(run: Run, written: Written, subject: Subject): string {
  const { symbol, held } = subject;
  const writes = held.writes.length === 1 ? "once" : `at ${String(held.writes.length)} positions`;
  const read = run.input.stores.readInTests.has(symbol.id)
    ? "read only from test files"
    : "never read";
  const cascade = [
    ...parametersOnlyNamedBy(run, written.namedBy, symbol).map((name) => `type parameter ${name}`),
    ...[...held.alone].sort(bytewise).map((name) => `import ${name}`),
    ...(written.named.get(symbol.id) ?? []),
  ];
  const word = SUBJECT_WORDS[symbol.kind] ?? "member";
  const message = `${word} ${symbol.name} is written ${writes} and ${read}`;
  return cascade.length === 0
    ? message
    : `${message}, and deleting it with its writes deletes ${cascade.join(" and ")} too`;
}

/** One declaration the write-only kind reports, with its uses. */
interface Subject {
  readonly symbol: InventorySymbol;
  readonly held: Uses;
}

/**
 * What the write-only kind answers of one run: its subjects in site order, and the
 * declarations that fall with them, each named under the innermost subject of every chain
 * of carriers its references hold.
 */
interface Written {
  readonly subjects: readonly Subject[];
  readonly namedBy: ReadonlyMap<string, ReadonlySet<string>>;
  readonly named: ReadonlyMap<string, readonly string[]>;
  readonly falls: ReadonlySet<string>;
}

/**
 * The kinds of declaration that fall with a write-only subject: a declaration of its own.
 * A member falls with its container, and a type parameter is the type-parameter clause's.
 */
const FALLING: ReadonlySet<InventorySymbol["kind"]> = new Set([
  "function",
  "class",
  "interface",
  "type",
  "enum",
  "namespace",
  "variable",
]);

const WRITTEN = new WeakMap<EmitterInput, Written>();

/**
 * `DS1301`'s subjects: a module-level variable, a type member or a class member the
 * counted references store into and never read.
 *
 * The subject is a live declaration: a store is a reference, so the sweep holds a
 * written one live and its candidates are never this kind's. Every reference that is
 * not a store reads, and so does an exemption record naming the declaration.
 */
function writtenOf(run: Run): Written {
  const known = WRITTEN.get(run.input);
  if (known !== undefined) {
    return known;
  }
  const { stores } = run.input;
  const { matrix, sweep } = run.input.swept;
  const uses = new Map<string, Uses>();
  for (const reference of stores.references) {
    let held = uses.get(reference.to);
    if (held === undefined) {
      held = { writes: [], reads: 0, alone: new Set() };
      uses.set(reference.to, held);
    }
    // A consumer's store is written at a position no report of the target can name, so
    // it counts as a use that keeps the declaration from this kind.
    if (reference.use !== "write" || reference.consumer !== undefined) {
      held.reads += 1;
      continue;
    }
    for (const name of reference.alone ?? []) {
      held.alone.add(name);
    }
    const at = reference.position;
    const key = positionKey(at);
    if (!held.writes.some((written) => positionKey(written) === key)) {
      held.writes.push({ path: at.path, line: at.line, column: at.column, endLine: at.line });
    }
  }

  const namedBy = new Map<string, Set<string>>();
  for (const reference of stores.references) {
    if (run.symbols.get(reference.to)?.kind === "type-parameter") {
      namedBy.set(reference.to, (namedBy.get(reference.to) ?? new Set()).add(reference.from));
    }
  }

  const subjects = matrix.union.symbols.flatMap((symbol): Subject[] => {
    const held = uses.get(symbol.id);
    return held === undefined ||
      held.writes.length === 0 ||
      held.reads > 0 ||
      !writable(run, symbol) ||
      stores.exempt.has(symbol.id) ||
      run.candidates.has(symbol.id)
      ? []
      : [{ symbol, held }];
  });
  const subjectIds = new Set(subjects.map((subject) => subject.symbol.id));
  const classOf = reachabilityClasses(run.input);
  const named = new Map<string, string[]>();
  const falls = new Set<string>();
  for (const symbol of matrix.union.symbols) {
    const chains = sweep.carried.get(symbol.id);
    if (
      chains === undefined ||
      subjectIds.has(symbol.id) ||
      !FALLING.has(symbol.kind) ||
      classOf(symbol.id) !== "certain"
    ) {
      continue;
    }
    const innermost = chains.map((chain) => chain.find((id) => subjectIds.has(id)));
    if (innermost.includes(undefined)) {
      continue;
    }
    falls.add(symbol.id);
    for (const subject of new Set(innermost)) {
      const name = `${WORDS[symbol.kind]} ${symbol.name}`;
      named.set(subject ?? "", [...(named.get(subject ?? "") ?? []), name]);
    }
  }
  const written = { subjects, namedBy, named, falls };
  WRITTEN.set(run.input, written);
  return written;
}

/** `DS1301`: each subject, named with every position written and what falls with it. */
function writeOnlySymbols(run: Run): readonly Finding[] {
  const written = writtenOf(run);
  return written.subjects.map((subject) =>
    findingAbout(subject.symbol, CODE.writeOnlySymbol, writeOnlyMessage(run, written, subject), {
      writePositions: subject.held.writes,
    }),
  );
}

/**
 * The candidates no reference of any file names whose container is not itself dead, of
 * one kind. A reference from a test file alone leaves a candidate to the test-only kind,
 * and a member of a dead container falls with it and is reported inside its component.
 */
function unnamed(run: Run, kind: InventorySymbol["kind"]): readonly InventorySymbol[] {
  return run.input.swept.sweep.candidates.flatMap((candidate): InventorySymbol[] => {
    const symbol = run.symbols.get(candidate.id);
    if (
      symbol?.kind !== kind ||
      candidate.productionRefs > 0 ||
      candidate.testRefs > 0 ||
      run.candidates.has(symbol.parent)
    ) {
      return [];
    }
    return [symbol];
  });
}

/**
 * `DS1005`: a member of an enum declaration that nothing names. A member an enum-group
 * record holds back is no candidate, so a member a conversion can produce never reaches
 * this kind.
 */
function unusedEnumMembers(run: Run): readonly Finding[] {
  return unnamed(run, "enum-member").map((symbol) =>
    findingAbout(symbol, CODE.unusedEnumMember, `enum member ${symbol.name} is named nowhere`),
  );
}

/**
 * `DS1006`: a type parameter of a function, a class method or a type alias that neither
 * the declaration's signature nor its body names. An alias names no type of its own, so
 * a parameter its type never names makes no two instantiations distinct. One of a class,
 * an interface or a method signature is never reported: a class or an interface merges
 * only with declarations of the same parameters.
 */
function unusedTypeParameters(run: Run): readonly Finding[] {
  return unnamed(run, "type-parameter")
    .filter((symbol) => SIGNATURES.has(run.symbols.get(symbol.parent)?.kind ?? ""))
    .map((symbol) =>
      findingAbout(
        symbol,
        CODE.unusedTypeParameter,
        `type parameter ${symbol.name} is named in neither its signature nor its body`,
      ),
    );
}

/**
 * The keys of the declarations the write-only kind reports, whatever the
 * severity: a narrowing kind yields each to it, since deleting the declaration
 * supersedes narrowing it.
 */
export function writeOnlyDeclarations(input: EmitterInput): ReadonlySet<string> {
  return new Set(
    writtenOf(indexed(input)).subjects.map(({ symbol }) =>
      declarationKey(symbol.ref, symbol.position.path),
    ),
  );
}

/**
 * The declarations that fall with a write-only subject, whatever the severity: a finding
 * about one would name code its subject's deletion already deletes.
 */
export function fallingWithWrites(input: EmitterInput): ReadonlySet<string> {
  return writtenOf(indexed(input)).falls;
}

/**
 * The findings of the reads-and-writes kinds, `DS1301`, `DS1005` and `DS1006`, in that
 * order and each code's in site order.
 */
export const readsAndWrites: Emitter = (input) => {
  const run = indexed(input);
  return [...writeOnlySymbols(run), ...unusedEnumMembers(run), ...unusedTypeParameters(run)];
};
