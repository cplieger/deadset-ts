import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { analyzeProject, type Analyzed } from "../__test-helpers__/projects.ts";
import type { InventorySymbol } from "./inventory.ts";
import type { Reference, ReferenceOptions } from "./references.ts";

/**
 * One iteration of each property below writes a project, opens a compiler client and a
 * snapshot over it, and resolves the declarations and then the references of it. That is
 * the whole cost of a draw and it is what sets the run counts. Measured: 43 to 52 ms a
 * draw on an idle machine, alone and inside the suite alike, and 127 to 162 ms a draw on
 * one loaded by another package's race battery. The shared configuration bounds a
 * property at ten seconds and fails the run for crossing it, so each of the three takes
 * 20 draws: 3.3 seconds at the worst of the loaded figures, which leaves more than half
 * the bound. The tree changes per iteration, so one snapshot cannot serve several draws:
 * a snapshot is never updated, which is what makes a run's answer independent of the
 * order it reads in.
 */

/** The compiler configuration a drawn project carries. */
const TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      strict: true,
      target: "ESNext",
      module: "NodeNext",
      moduleResolution: "nodenext",
      noEmit: true,
      allowImportingTsExtensions: true,
    },
    include: ["**/*.ts"],
  },
  null,
  2,
)}\n`;

/** The one project a drawn tree becomes, resolved under `options`. */
function analyze(files: Readonly<Record<string, string>>, options: ReferenceOptions): Analyzed {
  return analyzeProject({ "tsconfig.json": TSCONFIG, ...files }, { references: options });
}

/** The declarations of the drawn project, whose positions the assertions are read by. */
function symbolsOf(analyzed: Analyzed): readonly InventorySymbol[] {
  return analyzed.inventories[0]?.symbols ?? [];
}

/** The references of the drawn project. */
function referencesOf(analyzed: Analyzed): readonly Reference[] {
  return analyzed.references[0]?.references ?? [];
}

/** The declaration at one path and display name. */
function declaredAt(analyzed: Analyzed, path: string, name: string): InventorySymbol | undefined {
  return symbolsOf(analyzed).find(
    (symbol) => symbol.position.path === path && symbol.name === name,
  );
}

/**
 * Property dead-code-suite/P31: the round trips a run makes are bounded by its batches
 * plus its per-node fallbacks, so the pass does not grow with the identifier count.
 *
 * The oracle is the client's own request counter, read either side of the pass, against
 * the pass's own accounting of what it asked: the two are independent measurements of
 * one thing, so a crossing the accounting does not name fails, and so does a batch
 * spent per name rather than per capped run of names. The satisfaction pass has its own
 * term and contributes none here, because this pass compares no types.
 *
 * It can fail in three ways that matter. The pass asks per node, and the request count
 * stops matching the batch count at any cap above one. The pass asks something it does
 * not count, and the request count exceeds the accounting. Or the batch stops being
 * capped, and the count stops rising as the cap falls.
 */
describe("batching", () => {
  it("bounds the round trips by the batches and the fallbacks, whatever the names cost", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 24 }), fc.integer({ min: 1, max: 8 }), (reads, cap) => {
        const body = Array.from({ length: reads }, () => "    seed").join(" +\n");
        const analyzed = analyze(
          {
            "unit.ts": `export const seed = 1;\n\nexport function reader(): number {\n  return (\n${body}\n  );\n}\n`,
          },
          { testFiles: [], batchCap: cap },
        );
        const cost = analyzed.references[0]?.cost;

        expect(cost?.batched, "every name of the file reaches a batch").toBeGreaterThanOrEqual(
          reads,
        );
        expect(cost?.fileBatches, "one batch per capped run of them").toBe(
          Math.ceil((cost?.batched ?? 0) / cap),
        );
        expect(
          analyzed.referenceRequests,
          "and the requests the client measured are the ones the pass accounts for",
        ).toBe(
          (cost?.fileBatches ?? 0) +
            (cost?.residueFallbacks ?? 0) +
            (cost?.shorthandLookups ?? 0) +
            (cost?.aliasSteps ?? 0),
        );
      }),
      { numRuns: 20 },
    );
  }, 20_000);
});

/**
 * Property dead-code-suite/P8: the production and test reference split decides the kind.
 *
 * The drawn project holds the same declaration twice: once referenced from a test file
 * alone, and once with one of those references moved into a production file. So one draw
 * carries both sides of the move, and the two answers are read from one analysis.
 *
 * What the pass answers is the classification, which is what this asserts: the kind a
 * declaration with no production reference is reported under is the sweep's answer and
 * not this pass's. It can fail by classifying a file by something other than the
 * configured pattern, by classifying a reference by the file it names rather than the
 * file that made it, or by losing the moved reference.
 */
describe("the production and test split", () => {
  it("marks a reference by the file that made it, so moving one changes the split", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 5 }), (uses) => {
        const subject = "export function subject(): number {\n  return 0;\n}\n";
        const calls = (count: number): string =>
          `import { subject } from "./subject.ts";\n\nexport function exercise(): number {\n  return ${Array.from(
            { length: count },
            () => "subject()",
          ).join(" + ")};\n}\n`;
        const analyzed = analyze(
          {
            "only/subject.ts": subject,
            "only/subject.test.ts": calls(uses),
            "moved/subject.ts": subject,
            "moved/subject.test.ts": calls(uses - 1),
            "moved/use.ts": calls(1),
          },
          { testFiles: ["**/*.test.ts"] },
        );
        const split = (path: string): { test: number; production: number } => {
          const held = declaredAt(analyzed, path, "subject");
          const named = referencesOf(analyzed).filter((reference) => reference.to === held?.id);
          return {
            test: named.filter((reference) => reference.test).length,
            production: named.filter((reference) => !reference.test).length,
          };
        };

        expect(split("only/subject.ts"), "every use is made by a test file").toEqual({
          test: uses,
          production: 0,
        });
        expect(split("moved/subject.ts"), "one of them moved into a production file").toEqual({
          test: uses - 1,
          production: 1,
        });
      }),
      { numRuns: 20 },
    );
  }, 20_000);
});

/**
 * Property dead-code-suite/P9: a write with no read is recorded with its write positions.
 *
 * The oracle is the drawn operation list: each operation is written on a line of its own
 * and the draw knows which lines it made writes on, so the expected set is the draw's own
 * record rather than a second copy of the classification. The mix is drawn over a
 * module-level binding and a class member together, because the two reach the pass by
 * different routes: a name of its own, and a member named through a receiver.
 *
 * What the pass answers is the write set, which is what this asserts; whether a symbol
 * written and never read is reported is the sweep's answer. It can fail by classifying a
 * compound assignment or an increment as a read as well as a write, which makes a
 * write-only declaration read, and by missing a write of either route.
 */
type Operation = "assign" | "compound" | "increment" | "read";

/** Whether one operation stores into its subject. */
function stores(operation: Operation): boolean {
  return operation !== "read";
}

/** The line one operation is written as, for a binding and for a member. */
function written(operation: Operation): { binding: string; member: string } {
  switch (operation) {
    case "assign":
      return { binding: "  counter = 1;", member: "  holder.slot = 1;" };
    case "compound":
      return { binding: "  counter += 1;", member: "  holder.slot += 1;" };
    case "increment":
      return { binding: "  counter++;", member: "  holder.slot++;" };
    case "read":
      return { binding: "  sink(counter);", member: "  sink(holder.slot);" };
  }
}

describe("reads and writes", () => {
  it("records every write with its position, and a read only where one is written", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom<Operation>("assign", "compound", "increment", "read"), {
          minLength: 1,
          maxLength: 8,
        }),
        (operations) => {
          const header = [
            "export let counter = 0;",
            "",
            "export class Holder {",
            "  slot = 0;",
            "}",
            "",
            "const holder = new Holder();",
            "",
            "function sink(value: number): void {",
            "  void value;",
            "}",
            "",
            "export function run(): void {",
          ];
          const lines = [
            ...header,
            ...operations.flatMap((operation) => {
              const held = written(operation);
              return [held.binding, held.member];
            }),
            "}",
            "",
          ];
          const analyzed = analyze({ "unit.ts": `${lines.join("\n")}\n` }, { testFiles: [] });
          const at = (name: string, use: "read" | "write"): number[] => {
            const held = declaredAt(analyzed, "unit.ts", name);
            return referencesOf(analyzed)
              .filter((reference) => reference.to === held?.id && reference.use === use)
              .map((reference) => reference.position.line);
          };
          // The operations start on the line after the header, each taking two lines:
          // the binding's and the member's.
          const line = (index: number, member: boolean): number =>
            header.length + index * 2 + (member ? 2 : 1);
          const expected = (member: boolean, use: "read" | "write"): number[] =>
            operations.flatMap((operation, index) =>
              stores(operation) === (use === "write") ? [line(index, member)] : [],
            );

          expect(at("counter", "write")).toEqual(expected(false, "write"));
          expect(at("counter", "read")).toEqual(expected(false, "read"));
          expect(at("Holder.slot", "write")).toEqual(expected(true, "write"));
          expect(at("Holder.slot", "read")).toEqual(expected(true, "read"));
        },
      ),
      { numRuns: 20 },
    );
  }, 20_000);
});
