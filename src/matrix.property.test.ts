import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { InventorySymbol } from "./inventory.ts";
import { matrixOf, sweepMatrix, type Configured } from "./matrix.ts";
import type { Reference } from "./references.ts";

const PATH = "src/a.ts";

/** One declaration of the drawn file at one line, as the inventory spells it. */
function declaration(
  line: number,
  name: string,
  kind: InventorySymbol["kind"] = "function",
): InventorySymbol {
  return {
    id: `${PATH}:${String(line)}:1`,
    ref: `ts://@example/drawn/${PATH}#${name}`,
    name,
    kind,
    position: { path: PATH, line, column: 1 },
    endLine: line,
    parent: kind === "file" ? "" : `${PATH}:1:1`,
    exported: false,
    visibility: "public",
    static: false,
  };
}

const FILE = declaration(1, PATH, "file");
/** The one declaration every configuration holds and roots: a caller the configuration names. */
const MAIN = declaration(2, "main");
const FUNCTIONS = Array.from({ length: 6 }, (_, at) => declaration(10 + at, `f${String(at)}`));

/** One call from a function to a function. */
interface Call {
  readonly from: number;
  readonly to: number;
}

/** One configuration of a drawn matrix: what it holds, and who calls what in it. */
interface DrawnConfiguration {
  /** The functions the configuration's project holds. */
  readonly held: readonly number[];
  /** The held functions `main` calls. */
  readonly fromMain: readonly number[];
  /** The calls between held functions. */
  readonly calls: readonly Call[];
}

/** The calls of a configuration holding no function. */
const NO_CALLS: readonly Call[] = [];

const configuration: fc.Arbitrary<DrawnConfiguration> = fc
  .subarray(FUNCTIONS.map((_, at) => at))
  .chain((held) => {
    const calls =
      held.length === 0
        ? fc.constant(NO_CALLS)
        : fc.uniqueArray(
            fc.record({ from: fc.constantFrom(...held), to: fc.constantFrom(...held) }),
            { maxLength: 4, selector: (call) => `${String(call.from)}>${String(call.to)}` },
          );
    return fc.record({ held: fc.constant(held), fromMain: fc.subarray(held), calls });
  });

const matrix = fc.array(configuration, { minLength: 1, maxLength: 5 });

function reference(from: InventorySymbol, to: InventorySymbol, at: number): Reference {
  return {
    from: from.id,
    to: to.id,
    position: { path: PATH, line: from.position.line, column: 2 + at },
    use: "read",
    resolution: "batch",
    test: false,
  };
}

/** What the passes would answer for one drawn configuration. */
function configured(drawn: DrawnConfiguration, index: number): Configured {
  const fn = (at: number): InventorySymbol => FUNCTIONS[at] ?? MAIN;
  return {
    configuration: `c${String(index)}`,
    symbols: [FILE, MAIN, ...drawn.held.map(fn)],
    references: [
      ...drawn.fromMain.map((to, at) => reference(MAIN, fn(to), at)),
      ...drawn.calls.map((call, at) => reference(fn(call.from), fn(call.to), at)),
    ],
    roots: [{ id: MAIN.id, kind: "configured", source: "main" }],
    testFiles: [],
  };
}

/**
 * The functions one configuration holds dead: those no reference names, or those `main`
 * reaches no path of calls to. Every reference counts, a dead caller's included.
 */
function deadIn(drawn: DrawnConfiguration): Set<number> {
  const named = new Set([...drawn.fromMain, ...drawn.calls.map((call) => call.to)]);
  const reached = new Set<number>();
  const queue = [...drawn.fromMain];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    if (reached.has(next)) {
      continue;
    }
    reached.add(next);
    queue.push(...drawn.calls.filter((call) => call.from === next).map((call) => call.to));
  }
  return new Set(drawn.held.filter((at) => !named.has(at) || !reached.has(at)));
}

describe("the matrix intersection", () => {
  /**
   * Property dead-code-suite/P11: for any matrix of configurations, each holding its own
   * declarations and making its own references, a declaration is reported exactly when it
   * is dead in every configuration that holds it, a declaration no configuration holds is
   * not reported at all, and each reported one names the configurations that hold it.
   */
  it("reports only what is dead in every configuration that holds it", () => {
    fc.assert(
      fc.property(matrix, (drawn) => {
        const swept = sweepMatrix(matrixOf(drawn.map(configured)), {
          marked: [],
          mode: { production: true },
        });
        const dead = drawn.map(deadIn);
        const expected = FUNCTIONS.flatMap((symbol, at) => {
          const holders = drawn.flatMap((one, index) =>
            one.held.includes(at) ? [`c${String(index)}`] : [],
          );
          const everywhere = drawn.every(
            (one, index) => !one.held.includes(at) || dead[index]?.has(at),
          );
          return holders.length > 0 && everywhere ? [`${symbol.name} ${holders.join(",")}`] : [];
        });

        expect(
          swept.candidates.map(
            (candidate) =>
              `${FUNCTIONS.find((one) => one.id === candidate.id)?.name ?? candidate.id} ${candidate.configurations.join(",")}`,
          ),
        ).toEqual(expected);
      }),
    );
  });
});
