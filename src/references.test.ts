import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixture, ROOT } from "../__test-helpers__/fixtures.ts";
import { analyzeRoot } from "../__test-helpers__/projects.ts";
import type { InventorySymbol } from "./inventory.ts";
import { positionKey } from "./position.ts";
import { DEFAULT_BATCH_CAP, type Reference } from "./references.ts";

/**
 * The fixture holding one instance of every reference form, resolved once for every
 * case in this file: opening a compiler client and a snapshot is the expensive part of
 * a run, and every case here reads the same table.
 */
const EVERY_REFERENCE = analyzeRoot(fixture("projects", "every-reference"), {
  references: { testFiles: ["**/*.test.{ts,tsx,mts,cts}"] },
});
const INVENTORY = EVERY_REFERENCE.inventories[0];
const RESOLVED = EVERY_REFERENCE.references[0];
const SYMBOLS: readonly InventorySymbol[] = INVENTORY?.symbols ?? [];
const REFERENCES: readonly Reference[] = RESOLVED?.references ?? [];

/** The golden table: one reference per line, so a diff names the rows that moved. */
function goldenText(references: readonly Reference[]): string {
  const rows = references.map((reference) =>
    JSON.stringify({
      at: positionKey(reference.position),
      from: reference.from,
      to: reference.to,
      use: reference.use,
      resolution: reference.resolution,
      test: reference.test,
    }),
  );
  return `[\n${rows.map((row) => `  ${row}`).join(",\n")}\n]\n`;
}

/** The declaration one display name identifies. */
function declaration(name: string): InventorySymbol | undefined {
  return SYMBOLS.find((symbol) => symbol.name === name);
}

/** The position and use of every reference naming the declaration `name` identifies. */
function to(name: string): string[] {
  const held = declaration(name);
  return REFERENCES.filter((reference) => reference.to === held?.id).map(
    (reference) => `${positionKey(reference.position)} ${reference.use}`,
  );
}

describe("the reference table of every reference form", () => {
  it("is the committed golden table, reference for reference", async () => {
    await expect(
      goldenText(REFERENCES),
      "the table is produced by the production path; to record a reviewed change run " +
        "`npx vitest --run -u src/references.test.ts` and read the diff as production code",
    ).toMatchFileSnapshot(fixture("golden", "every-reference.references.json"));
  });

  it("resolves every form through the accessor that answers for it", () => {
    const counts = new Map<string, number>();
    for (const reference of REFERENCES) {
      counts.set(reference.resolution, (counts.get(reference.resolution) ?? 0) + 1);
    }

    expect(
      [...counts].sort(([a], [b]) => (a < b ? -1 : 1)),
      "a batch answers for most of the names and the two per-node paths for the rest",
    ).toEqual([
      ["alias", 14],
      ["batch", 17],
      ["shorthand", 3],
    ]);
  });

  it("spends one batch per file that carries a name to resolve, and no more", () => {
    // Three of the fixture's four files carry a name that is a use; the fourth writes
    // nothing but re-exports, whose names are where its own declarations are written.
    expect(RESOLVED?.cost.fileBatches, "one batch per such file, at the default cap").toBe(3);
    expect(REFERENCES.length, "and every name of the fixture is far below the cap").toBeLessThan(
      DEFAULT_BATCH_CAP,
    );
    expect(
      RESOLVED?.cost.shorthandLookups,
      "one lookup per shorthand property, the one naming a parameter included: it costs " +
        "the lookup and names no declaration of the inventory",
    ).toBe(4);
    expect(
      RESOLVED?.cost.aliasSteps,
      "one step per link of each chain, resolved once per alias whatever the number of " +
        "uses it has: the collection two statements reach through one import costs one",
    ).toBe(11);
    expect(
      RESOLVED?.cost.residueFallbacks,
      "and no name here is residue: a statement label is the form a batch leaves, and a " +
        "label names no declaration",
    ).toBe(0);
    expect(
      EVERY_REFERENCE.referenceRequests,
      "the requests the client measured are the ones the pass accounts for: a declaration " +
        "outside the project's own files is never fetched to find out that the inventory " +
        "does not hold it",
    ).toBe(3 + 0 + 4 + 11);
  });

  it("accounts for every request over a tree of more than one project", () => {
    const analyzed = analyzeRoot(fixture("projects", "two-projects"), {
      references: { testFiles: [] },
    });
    const accounted = analyzed.references.reduce(
      (total, held) =>
        total +
        held.cost.fileBatches +
        held.cost.residueFallbacks +
        held.cost.shorthandLookups +
        held.cost.aliasSteps,
      0,
    );

    expect(analyzed.references.length, "one pass per compiler configuration").toBe(2);
    expect(analyzed.referenceRequests, "and one accounting across them").toBe(accounted);
  });

  it("names the declaration a re-export chain carries, and every link of the chain", () => {
    const declared = declaration("recursive");
    const link = SYMBOLS.find(
      (symbol) => symbol.kind === "export-alias" && symbol.name === "recursive",
    );
    // The call in index.ts is written against middle.ts, which re-exports what
    // declarations.ts declares, so it names both the link and the declaration.
    const call = REFERENCES.filter(
      (reference) => positionKey(reference.position) === "src/index.ts:13:16",
    );

    expect(link?.position.path, "the link is the re-export in the middle module").toBe(
      "src/middle.ts",
    );
    expect(call.map((reference) => reference.to).sort()).toEqual(
      [declared?.id, link?.id].sort((a, b) => ((a ?? "") < (b ?? "") ? -1 : 1)),
    );
    expect(call.map((reference) => reference.resolution)).toEqual(["alias", "alias"]);
  });

  it("names the declaration a type-only re-export carries", () => {
    const named = declaration("Named");

    expect(named?.kind, "the declaration behind the type-only re-export is the type").toBe(
      "interface",
    );
    expect(to("Named"), "named once, in the return type the using module writes").toEqual([
      "src/index.ts:9:37 read",
    ]);
  });

  it("records a self-reference and nothing at a declaration's own name", () => {
    const recursive = declaration("recursive");
    const own = REFERENCES.filter(
      (reference) =>
        reference.to === recursive?.id && reference.position.path === "src/declarations.ts",
    );

    expect(
      own.map((reference) => positionKey(reference.position)),
      "the call in its own body, and not the name it is declared under",
    ).toEqual(["src/declarations.ts:3:27"]);
    expect(
      own.map((reference) => reference.from),
      "which it makes itself",
    ).toEqual([recursive?.id]);
    expect(recursive?.id, "the name it is declared under is a position of its own").toBe(
      "src/declarations.ts:2:17",
    );
  });

  it("resolves a member through a receiver, an element access and its class", () => {
    expect(to("Holder.slot"), "a property access writes the member it names").toEqual([
      "src/declarations.ts:23:10 write",
      "src/index.ts:6:6 write",
    ]);
    expect(to("Holder.total"), "a static member named through the class").toEqual([
      "src/declarations.ts:24:12 write",
    ]);
    expect(to("Holder.value"), "a getter and a setter of one name are one declaration").toEqual([
      "src/declarations.ts:25:17 read",
      "src/index.ts:10:8 write",
    ]);
    expect(to("Holder.#hidden"), "a private name resolves like any other").toEqual([
      "src/declarations.ts:15:17 read",
      "src/declarations.ts:19:10 write",
    ]);
    expect(
      to("table"),
      "an element access writes the collection it stores into, and so does a delete",
    ).toEqual(["src/index.ts:11:3 write", "src/index.ts:12:10 write"]);
  });

  it("resolves a shorthand property assignment to the declaration it reads", () => {
    const shorthand = REFERENCES.filter((reference) => reference.resolution === "shorthand");

    expect(
      shorthand.map((reference) => `${positionKey(reference.position)} ${reference.use}`),
      "a shorthand in an object literal reads, and one in a destructuring target writes",
    ).toEqual([
      "src/declarations.ts:50:6 write",
      "src/index.ts:21:25 read",
      "src/index.ts:21:31 read",
    ]);
    expect(
      shorthand.map((reference) => reference.to),
      "each naming the declaration it reads rather than the property it declares",
    ).toEqual([declaration("loose")?.id, declaration("held")?.id, declaration("use")?.id]);
  });

  it("classifies a compound assignment and an increment as writes alone", () => {
    expect(
      to("counter"),
      "each reads its target only to write the result back, so nothing reads it",
    ).toEqual(["src/declarations.ts:48:3 write", "src/declarations.ts:49:3 write"]);
  });

  it("carries the enclosing declaration, and the file where no declaration encloses", () => {
    const file = SYMBOLS.find(
      (symbol) => symbol.kind === "file" && symbol.position.path === "src/index.ts",
    );
    const inUse = REFERENCES.filter((reference) => reference.from === declaration("use")?.id);

    expect(inUse.length, "the body of one function makes several references").toBeGreaterThan(5);
    expect(
      REFERENCES.filter((reference) => reference.from === file?.id).map((reference) =>
        positionKey(reference.position),
      ),
      "and a statement outside every declaration belongs to the file",
    ).toEqual(["src/index.ts:6:1", "src/index.ts:6:6"]);
  });

  it("marks every reference a test file makes, and no other", () => {
    const test = REFERENCES.filter((reference) => reference.test);

    expect(
      [...new Set(test.map((reference) => reference.position.path))],
      "one file of the fixture matches the pattern",
    ).toEqual(["src/unit.test.ts"]);
    expect(RESOLVED?.testFileRules).toEqual([{ rule: "test-file-pattern-1", matched: 1 }]);
  });
});

describe("the test-file pattern", () => {
  it("measures a project whose tests are named another way, once configured", () => {
    const under = analyzeRoot(fixture("projects", "every-reference"), {
      references: { testFiles: ["src/unit.*.ts", "**/*.spec.ts"] },
    });
    const held = under.references[0];

    expect(held?.testFileRules, "each pattern is a rule of its own and reports its count").toEqual([
      { rule: "test-file-pattern-1", matched: 1 },
      { rule: "test-file-pattern-2", matched: 0 },
    ]);
    expect(
      [
        ...new Set(
          (held?.references ?? [])
            .filter((reference) => reference.test)
            .map((reference) => reference.position.path),
        ),
      ],
      "the same file, reached by the configured pattern instead of the default",
    ).toEqual(["src/unit.test.ts"]);
  });

  it("accepts a pattern naming a hyphenated path, and a question mark", () => {
    const under = analyzeRoot(fixture("projects", "every-reference"), {
      references: { testFiles: ["src/unit-?.ts", "**/*.test.?s"] },
    });
    const held = under.references[0];

    expect(held?.testFileRules, "the second pattern is the one this tree answers").toEqual([
      { rule: "test-file-pattern-1", matched: 0 },
      { rule: "test-file-pattern-2", matched: 1 },
    ]);
  });

  it("classifies nothing where no pattern matches", () => {
    const under = analyzeRoot(fixture("projects", "every-reference"), {
      references: { testFiles: ["**/*.spec.ts"] },
    });
    const held = under.references[0];

    expect(held?.testFileRules).toEqual([{ rule: "test-file-pattern-1", matched: 0 }]);
    expect((held?.references ?? []).filter((reference) => reference.test)).toEqual([]);
  });
});

describe("the per-symbol reference accessors", () => {
  it("appear in no file of this analyzer, this one included", () => {
    // Spelled in parts so the scan covers every file of the analyzer, the file making
    // the claim among them: a name written whole here would be the one hit.
    const forbidden = [`getReferences${"ToSymbolInFile"}`, `getReferenced${"SymbolsForNode"}`];
    const found: string[] = [];
    const walk = (at: string): void => {
      for (const entry of readdirSync(at, { withFileTypes: true })) {
        const path = join(at, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!path.endsWith(".ts") && !path.endsWith(".mjs")) {
          continue;
        }
        const text = readFileSync(path, "utf8");
        for (const name of forbidden) {
          if (text.includes(name)) {
            found.push(`${path.slice(ROOT.length + 1)}: ${name}`);
          }
        }
      }
    };
    walk(join(ROOT, "src"));
    walk(join(ROOT, "bin"));
    walk(join(ROOT, "scripts"));
    walk(join(ROOT, "__test-helpers__"));

    expect(
      found,
      "a per-symbol reference query is the shape whose answers depend on the order the " +
        "symbols are asked about",
    ).toEqual([]);
  });
});

describe("the default batch cap", () => {
  const record = JSON.parse(
    readFileSync(join(ROOT, "docs", "batch-cap-calibration.json"), "utf8"),
  ) as { chosenDefault: number; caps: readonly (number | string)[] };

  it("is the cap the calibration record chose", () => {
    expect(
      record.chosenDefault,
      "the default is read off the committed measurements, so moving one without the other " +
        "leaves the code taking a cap no run measured",
    ).toBe(DEFAULT_BATCH_CAP);
  });

  it("is one of the values the sweep measured", () => {
    expect(
      record.caps,
      "a chosen default the sweep never ran is a number, not a reading",
    ).toContain(DEFAULT_BATCH_CAP);
  });
});
