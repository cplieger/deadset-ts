/**
 * The one way the analysis asks a project's checker anything. A question the compiler
 * server panics on answers {@link UNANSWERED}, and a batch it panics on whole is asked
 * again one question at a time; every caller reads an unanswered question as keeping a
 * declaration live, and each is recorded once so a run can say where it was partial.
 * Questions of one accessor about many locations go out together, through the array
 * form where it has one and otherwise as one batch, one round trip per capped run.
 */

import { isIdentifier, type Expression, type Node } from "@typescript/native/unstable/ast";
import type {
  APIRequestGenerator,
  Checker,
  IndexInfo,
  JSDocTagInfo,
  Signature,
  SignatureKind,
  SymbolFlags,
  Symbol as TSSymbol,
  Type,
} from "@typescript/native/unstable/sync";

/**
 * The greatest number of locations one batched request asks about. A batch is
 * answered by an array of its own length, so an uncapped batch over a large file
 * makes one answer proportional to that file. The figure bounds the size of one
 * answer rather than the work: the median file is one batch at this cap and the
 * largest production file a handful.
 */
export const DEFAULT_BATCH_CAP = 4096;

/** The answer to a question the checker could not answer. */
export const UNANSWERED: unique symbol = Symbol("unanswered");

/** A checker's answer, or {@link UNANSWERED} where the server panicked on the question. */
export type Answer<T> = T | typeof UNANSWERED;

/** Whether one answer is an answer. */
export function isAnswered<T>(answer: Answer<T>): answer is T {
  return answer !== UNANSWERED;
}

/**
 * The stop a pass raises where it cannot go on without an answer the checker did not
 * give. Whoever runs the pass catches it and keeps live everything the pass could
 * have kept live, so a pass that throws it never computes a finding from the gap.
 */
export class Unanswerable extends Error {
  constructor() {
    super("the checker did not answer a question this pass needs");
    this.name = "Unanswerable";
  }
}

/** The answer itself, or the stop of a pass that cannot go on without it. */
export function must<T>(answer: Answer<T>): T {
  if (answer === UNANSWERED) {
    throw new Unanswerable();
  }
  return answer;
}

/**
 * Whether one failure is the server's report that a question panicked. The server
 * recovers the panic and answers the question with its text, so the session
 * survives it; any other failure, a closed channel among them, is not one this layer
 * contains.
 */
function panicked(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("panic:");
}

/** Runs many questions in one round trip, answering each in order. */
export type Batch = <T>(questions: readonly APIRequestGenerator<T>[]) => T[];

/**
 * Puts one question to the checker, by its accessor's name and the locations it asks
 * about, and answers what it answers.
 */
type Ask = <T>(accessor: string, locations: () => readonly string[], question: () => T) => T;

const ASK_DIRECTLY: Ask = (_accessor, _locations, question) => question();

/** One question the checker left unanswered, by the project it was asked in. */
export interface UnansweredQuestion {
  /** The compiler configuration file of the project the question was asked in. */
  readonly configFile: string;
  /** The accessor that panicked. */
  readonly accessor: string;
  /** What was asked about: a file and offset, or a symbol's or a type's identity. */
  readonly location: string;
}

/** What one run could not ask, each question once. */
export class UnansweredLog {
  readonly #seen = new Map<string, UnansweredQuestion>();

  /** Records one question, once however many times it is asked. */
  note(question: UnansweredQuestion): void {
    const key = [question.configFile, question.accessor, question.location].join("\u0000");
    if (!this.#seen.has(key)) {
      this.#seen.set(key, question);
    }
  }

  /** Every question recorded, in the order first asked. */
  get questions(): readonly UnansweredQuestion[] {
    return [...this.#seen.values()];
  }
}

function nodeLocation(node: Node): string {
  return `${node.getSourceFile().fileName}:${String(node.pos)}`;
}

function symbolLocation(symbol: TSSymbol): string {
  return `symbol ${String(symbol.id)} ${symbol.name}`;
}

function typeLocation(type: Type): string {
  return `type ${String(type.id)}`;
}

/** One assignability question. */
interface Assignability {
  readonly source: Type;
  readonly target: Type;
}

/**
 * Each type's properties, asked of the checker once per type for every pass that shares
 * the tables: the client keeps a type's properties once fetched, so a second pass asking
 * for the same type makes no request, and only the first ask is counted as one.
 */
export interface PropertyTables {
  /** One type's properties, and whether this call was the one that asked for them. */
  of(type: Type): { readonly properties: Answer<readonly TSSymbol[]>; readonly asked: boolean };
}

/** The property tables over one project's questions. */
export function propertyTables(queries: Pick<Queries, "propertiesOf">): PropertyTables {
  const held = new Map<number, Answer<readonly TSSymbol[]>>();
  return {
    of: (type) => {
      const known = held.get(type.id);
      if (known !== undefined) {
        return { properties: known, asked: false };
      }
      const properties = queries.propertiesOf(type);
      held.set(type.id, properties);
      return { properties, asked: true };
    },
  };
}

/** The questions one project's analysis asks, each guarded. */
export interface Queries {
  /** The symbol each node resolves to. */
  symbolsAt(nodes: readonly Node[], cap?: number): Answer<TSSymbol | undefined>[];
  /** The symbol one identifier names by name lookup at its position; nothing for another node. */
  resolvedSymbol(node: Node): Answer<TSSymbol | undefined>;
  /** The symbol the value of one shorthand property assignment names. */
  shorthandValue(node: Node): Answer<TSSymbol | undefined>;
  /** The symbol one alias names, one link along. */
  immediateAliased(symbol: TSSymbol): Answer<TSSymbol | undefined>;
  /** The symbol at the end of one alias's chain. */
  aliased(symbol: TSSymbol): Answer<TSSymbol>;
  resolveName(
    name: string,
    meaning: SymbolFlags,
    location: Node | undefined,
    excludeGlobals: boolean,
  ): Answer<TSSymbol | undefined>;
  exportsOfModule(module: TSSymbol): Answer<readonly TSSymbol[]>;
  /** One symbol's member table. */
  membersOf(symbol: TSSymbol): Answer<ReadonlyMap<string, TSSymbol>>;
  /** One symbol's export table. */
  exportsOf(symbol: TSSymbol): Answer<ReadonlyMap<string, TSSymbol>>;
  /** The symbol that declares one symbol as a member. */
  parentOf(symbol: TSSymbol): Answer<TSSymbol | undefined>;
  /** The documentation tags of each symbol. */
  jsDocTags(symbols: readonly TSSymbol[], cap?: number): Answer<readonly JSDocTagInfo[]>[];
  /** The type at each node. */
  typesAt(nodes: readonly Node[], cap?: number): Answer<Type | undefined>[];
  typeAt(node: Node): Answer<Type | undefined>;
  /** The type of each symbol. */
  typesOfSymbols(symbols: readonly TSSymbol[], cap?: number): Answer<Type | undefined>[];
  typeOfSymbol(symbol: TSSymbol): Answer<Type | undefined>;
  declaredTypeOf(symbol: TSSymbol): Answer<Type>;
  /** The type each value position expects. */
  contextualTypes(nodes: readonly Expression[], cap?: number): Answer<Type | undefined>[];
  propertiesOf(type: Type): Answer<readonly TSSymbol[]>;
  indexInfosOf(type: Type): Answer<readonly IndexInfo[]>;
  /** The type arguments of a type reference; none for another type. */
  typeArguments(type: Type): Answer<readonly Type[]>;
  nonNullable(type: Type): Answer<Type>;
  isArray(type: Type): Answer<boolean>;
  /** Whether each source is assignable to its target. */
  assignableEach(pairs: readonly Assignability[], cap?: number): Answer<boolean>[];
  /** The base types of a class or an interface; none for another type. */
  baseTypes(type: Type): Answer<readonly Type[]>;
  /** The constituents of a union or an intersection; the type itself for another type. */
  constituents(type: Type): Answer<readonly Type[]>;
  /** The generic type a type reference instantiates; the type itself for another type. */
  targetOf(type: Type): Answer<Type>;
  /** The symbol a type is declared by. */
  symbolOfType(type: Type): Answer<TSSymbol | undefined>;
  signaturesOf(type: Type, kind: SignatureKind): Answer<readonly Signature[]>;
  resolvedSignature(node: Node): Answer<Signature | undefined>;
  parameterType(signature: Signature, index: number): Answer<Type | undefined>;
  signatureOf(declaration: Node): Answer<Signature | undefined>;
  returnTypeOf(signature: Signature): Answer<Type | undefined>;
  typeToString(type: Type): Answer<string>;
}

/**
 * The guarded questions over one project's checker. `configFile` names the project
 * in the log, `batch` sends many questions in one round trip, `log` is the run's,
 * shared by every project, and every question is put through `ask`.
 */
export function queriesOf(
  checker: Checker,
  configFile: string,
  batch: Batch,
  log: UnansweredLog,
  ask: Ask = ASK_DIRECTLY,
): Queries {
  const note = (accessor: string, location: string): void => {
    log.note({ configFile, accessor, location });
  };

  const one = <T>(accessor: string, location: () => string, question: () => T): Answer<T> => {
    try {
      return ask(accessor, () => [location()], question);
    } catch (error: unknown) {
      if (!panicked(error)) {
        throw error;
      }
      note(accessor, location());
      return UNANSWERED;
    }
  };

  /**
   * One question per item of `items`, in runs of at most `cap`, each run in one
   * round trip. A run fails as a whole only where the server panics outside any one
   * question, and is then asked one question at a time.
   */
  const each = <In, Out>(
    accessor: string,
    items: readonly In[],
    cap: number,
    locate: (item: In) => string,
    question: (item: In) => APIRequestGenerator<Out>,
    alone: (item: In) => Out,
  ): Answer<Out>[] => {
    function* guarded(item: In): APIRequestGenerator<Answer<Out>> {
      try {
        return yield* ask(
          accessor,
          () => [locate(item)],
          () => question(item),
        );
      } catch (error: unknown) {
        if (!panicked(error)) {
          throw error;
        }
        note(accessor, locate(item));
        return UNANSWERED;
      }
    }
    const answers: Answer<Out>[] = [];
    for (let from = 0; from < items.length; from += cap) {
      const run = items.slice(from, from + cap);
      try {
        answers.push(...batch(run.map(guarded)));
      } catch (error: unknown) {
        if (!panicked(error)) {
          throw error;
        }
        answers.push(
          ...run.map((item) =>
            one(
              accessor,
              () => locate(item),
              () => alone(item),
            ),
          ),
        );
      }
    }
    return answers;
  };

  /**
   * One accessor's array form over `items`, in runs of at most `cap`. A run the server
   * panics on is asked again as two halves, down to one item, so the items it can
   * answer are answered and only an item that panics alone is unanswered.
   */
  const many = <In, Out>(
    accessor: string,
    items: readonly In[],
    cap: number,
    locate: (item: In) => string,
    question: (run: readonly In[]) => readonly Out[],
  ): Answer<Out>[] => {
    const answers: Answer<Out>[] = [];
    const settle = (run: readonly In[]): void => {
      try {
        answers.push(
          ...ask(
            accessor,
            () => run.map(locate),
            () => question(run),
          ),
        );
        return;
      } catch (error: unknown) {
        if (!panicked(error)) {
          throw error;
        }
      }
      const [only] = run;
      if (run.length === 1 && only !== undefined) {
        note(accessor, locate(only));
        answers.push(UNANSWERED);
        return;
      }
      const half = Math.ceil(run.length / 2);
      settle(run.slice(0, half));
      settle(run.slice(half));
    };
    for (let from = 0; from < items.length; from += cap) {
      settle(items.slice(from, from + cap));
    }
    return answers;
  };

  return {
    symbolsAt: (nodes, cap = DEFAULT_BATCH_CAP) =>
      many("getSymbolAtLocation", nodes, cap, nodeLocation, (run) =>
        checker.getSymbolAtLocation(run),
      ),
    resolvedSymbol: (node) =>
      isIdentifier(node)
        ? one(
            "getResolvedSymbol",
            () => nodeLocation(node),
            () => checker.getResolvedSymbol(node),
          )
        : undefined,
    shorthandValue: (node) =>
      one(
        "getShorthandAssignmentValueSymbol",
        () => nodeLocation(node),
        () => checker.getShorthandAssignmentValueSymbol(node),
      ),
    immediateAliased: (symbol) =>
      one(
        "getImmediateAliasedSymbol",
        () => symbolLocation(symbol),
        () => checker.getImmediateAliasedSymbol(symbol),
      ),
    aliased: (symbol) =>
      one(
        "getAliasedSymbol",
        () => symbolLocation(symbol),
        () => checker.getAliasedSymbol(symbol),
      ),
    resolveName: (name, meaning, location, excludeGlobals) =>
      one(
        "resolveName",
        () => (location === undefined ? `name ${name}` : nodeLocation(location)),
        () => checker.resolveName(name, meaning, location, excludeGlobals),
      ),
    exportsOfModule: (module) =>
      one(
        "getExportsOfModule",
        () => symbolLocation(module),
        () => checker.getExportsOfModule(module),
      ),
    membersOf: (symbol) =>
      one(
        "getMembers",
        () => symbolLocation(symbol),
        () => symbol.getMembers(),
      ),
    exportsOf: (symbol) =>
      one(
        "getExports",
        () => symbolLocation(symbol),
        () => symbol.getExports(),
      ),
    parentOf: (symbol) =>
      one(
        "getParent",
        () => symbolLocation(symbol),
        () => symbol.getParent(),
      ),
    jsDocTags: (symbols, cap = DEFAULT_BATCH_CAP) =>
      each(
        "getJsDocTags",
        symbols,
        cap,
        symbolLocation,
        (symbol) => symbol.getJsDocTags.gen(checker),
        (symbol) => symbol.getJsDocTags(checker),
      ),
    typesAt: (nodes, cap = DEFAULT_BATCH_CAP) =>
      many("getTypeAtLocation", nodes, cap, nodeLocation, (run) => checker.getTypeAtLocation(run)),
    typeAt: (node) =>
      one(
        "getTypeAtLocation",
        () => nodeLocation(node),
        () => checker.getTypeAtLocation(node),
      ),
    typesOfSymbols: (symbols, cap = DEFAULT_BATCH_CAP) =>
      many("getTypeOfSymbol", symbols, cap, symbolLocation, (run) => checker.getTypeOfSymbol(run)),
    typeOfSymbol: (symbol) =>
      one(
        "getTypeOfSymbol",
        () => symbolLocation(symbol),
        () => checker.getTypeOfSymbol(symbol),
      ),
    declaredTypeOf: (symbol) =>
      one(
        "getDeclaredTypeOfSymbol",
        () => symbolLocation(symbol),
        () => checker.getDeclaredTypeOfSymbol(symbol),
      ),
    contextualTypes: (nodes, cap = DEFAULT_BATCH_CAP) =>
      each(
        "getContextualType",
        nodes,
        cap,
        nodeLocation,
        (node) => checker.getContextualType.gen(node),
        (node) => checker.getContextualType(node),
      ),
    propertiesOf: (type) =>
      one(
        "getPropertiesOfType",
        () => typeLocation(type),
        () => checker.getPropertiesOfType(type),
      ),
    indexInfosOf: (type) =>
      one(
        "getIndexInfosOfType",
        () => typeLocation(type),
        () => checker.getIndexInfosOfType(type),
      ),
    typeArguments: (type) =>
      type.isTypeReference()
        ? one(
            "getTypeArguments",
            () => typeLocation(type),
            () => checker.getTypeArguments(type),
          )
        : [],
    nonNullable: (type) =>
      one(
        "getNonNullableType",
        () => typeLocation(type),
        () => checker.getNonNullableType(type),
      ),
    isArray: (type) =>
      one(
        "isArrayType",
        () => typeLocation(type),
        () => checker.isArrayType(type),
      ),
    assignableEach: (pairs, cap = DEFAULT_BATCH_CAP) =>
      each(
        "isTypeAssignableTo",
        pairs,
        cap,
        (pair) => `${typeLocation(pair.source)} to ${typeLocation(pair.target)}`,
        (pair) => checker.isTypeAssignableTo.gen(pair.source, pair.target),
        (pair) => checker.isTypeAssignableTo(pair.source, pair.target),
      ),
    baseTypes: (type) =>
      type.isClassOrInterface()
        ? one(
            "getBaseTypes",
            () => typeLocation(type),
            () => checker.getBaseTypes(type),
          )
        : [],
    constituents: (type) =>
      type.isUnionType() || type.isIntersectionType()
        ? one(
            "getTypes",
            () => typeLocation(type),
            () => type.getTypes(),
          )
        : [type],
    targetOf: (type) =>
      type.isTypeReference()
        ? one(
            "getTarget",
            () => typeLocation(type),
            () => type.getTarget(),
          )
        : type,
    symbolOfType: (type) =>
      one(
        "getSymbol",
        () => typeLocation(type),
        () => type.getSymbol(),
      ),
    signaturesOf: (type, kind) =>
      one(
        "getSignaturesOfType",
        () => typeLocation(type),
        () => checker.getSignaturesOfType(type, kind),
      ),
    resolvedSignature: (node) =>
      one(
        "getResolvedSignature",
        () => nodeLocation(node),
        () => checker.getResolvedSignature(node),
      ),
    parameterType: (signature, index) =>
      one(
        "getParameterType",
        () => `signature ${String(signature.id)} parameter ${String(index)}`,
        () => checker.getParameterType(signature, index),
      ),
    signatureOf: (declaration) =>
      one(
        "getSignatureFromDeclaration",
        () => nodeLocation(declaration),
        () => checker.getSignatureFromDeclaration(declaration),
      ),
    returnTypeOf: (signature) =>
      one(
        "getReturnTypeOfSignature",
        () => `signature ${String(signature.id)}`,
        () => checker.getReturnTypeOfSignature(signature),
      ),
    typeToString: (type) =>
      one(
        "typeToString",
        () => typeLocation(type),
        () => checker.typeToString(type),
      ),
  };
}
