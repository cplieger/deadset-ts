import { describe, expect, it } from "vitest";
import { readFixture } from "../__test-helpers__/fixtures.ts";
import { ConfigError } from "./config.ts";
import type { Host } from "./host.ts";
import type { InventorySymbol } from "./inventory.ts";
import { joinPath } from "./paths.ts";
import { isSymbolRef } from "./suppress.ts";
import {
  BASELINE_FILE,
  IGNORE_FILE,
  readBaseline,
  otherSchemeRows,
  readIgnoreFile,
  writeBaseline,
} from "./suppress-file.ts";
import { whole } from "../__test-helpers__/whole.ts";

/** One case of the published suppression token corpus. */
interface CorpusCase {
  readonly input: Readonly<Record<string, unknown>>;
  readonly kind: string;
  readonly accepted: boolean;
  readonly rule: string;
  readonly reports?: readonly string[];
}

const CORPUS = JSON.parse(
  readFixture("contract", "grammar", "suppression-corpus.json"),
) as readonly CorpusCase[];

const ROOT = "/target";

/** A target root holding the documents given, by name, and nothing else. */
function hostWith(documents: Readonly<Record<string, string>>): Host {
  const at = (path: string): string | undefined =>
    Object.entries(documents).find(([name]) => joinPath(ROOT, name) === path)?.[1];
  return {
    workingDirectory: () => ROOT,
    readFile: (path) => at(path) ?? "",
    readDirectory: () => [],
    kindOf: (path) => (at(path) === undefined ? "absent" : "file"),
    realPath: (path) => path,
    analyzerVersion: () => "0.0.0-devel",
    temporaryDirectory: () => {
      throw new Error("no temporary directory");
    },
    componentMapperCommand: () => [],
    writeDocument: (path) => {
      throw new Error(`${path}: this host writes nothing`);
    },
  };
}

/** A declaration of the run, as an entry names it. */
function declaration(ref: string, path: string, line = 3): InventorySymbol {
  return {
    id: `${path}:${String(line)}:1`,
    ref,
    name: ref.slice(ref.indexOf("#") + 1),
    kind: "function",
    position: { path, line, column: 1 },
    endLine: line,
    parent: "",
    exported: true,
    visibility: "public",
    static: false,
  };
}

/** The refusal outcome the grammar page's rule vocabulary gives a refused entry or row. */
const REFUSED: Readonly<Record<string, string>> = {
  "reason-required": "DS1701",
  "path-required": "DS1702",
  "path-form": "exit 2",
  "symbol-form": "exit 2",
  "code-form": "exit 2",
  "closed-keys": "exit 2",
  "value-type": "exit 2",
};

function declared(one: CorpusCase): string {
  if (one.accepted) {
    return "accepted";
  }
  return one.reports?.join(" ") ?? REFUSED[one.rule] ?? `no outcome for ${one.rule}`;
}

/** What this analyzer makes of one entry or row, written alone in its document. */
function outcome(one: CorpusCase): string {
  const [file, array, read] =
    one.kind === "ignore-entry"
      ? [IGNORE_FILE, "ignore", readIgnoreFile]
      : [BASELINE_FILE, "baseline", readBaseline];
  const { symbol, path } = one.input;
  const symbols =
    typeof symbol === "string" && typeof path === "string" ? [declaration(symbol, path)] : [];
  try {
    const held = read(
      hostWith({ [file]: JSON.stringify({ [array]: [one.input] }) }),
      ROOT,
      symbols,
    );
    if (held.refusals.length > 0) {
      return held.refusals.map((refused) => refused.reported).join(" ");
    }
    if (held.records.length === 0) {
      return "nothing";
    }
    return held.records.length === 1 && held.records[0]?.bound !== "" ? "accepted" : "unbound";
  } catch (error: unknown) {
    return error instanceof ConfigError ? "exit 2" : String(error);
  }
}

/** Whether a case names a well-formed reference of the other language's scheme. */
function otherScheme(one: CorpusCase): boolean {
  const { symbol } = one.input;
  return typeof symbol === "string" && isSymbolRef(symbol) && !symbol.startsWith("ts://");
}

/** The case with its other-scheme reference spelled as this language's, fragment kept. */
function ownTwin(one: CorpusCase): CorpusCase {
  const symbol = String(one.input["symbol"]);
  return {
    ...one,
    input: {
      ...one.input,
      symbol: `ts://@example/app/src/lib.ts${symbol.slice(symbol.indexOf("#"))}`,
    },
  };
}

describe("every entry and row case of the published token corpus", () => {
  const cases = CORPUS.filter((one) => one.kind !== "inline");

  it.each(cases.map((one) => [one.kind, JSON.stringify(one.input), one] as const))(
    "%s %s has the outcome the grammar declares, in the analyzer of its reference's language",
    (_kind, _input, one) => {
      expect(outcome(otherScheme(one) ? ownTwin(one) : one)).toBe(declared(one));
    },
  );

  it.each(
    cases.filter(otherScheme).map((one) => [one.kind, JSON.stringify(one.input), one] as const),
  )(
    "%s %s is form-checked here and otherwise left to the other language's analyzer",
    (_kind, _input, one) => {
      expect(outcome(one)).toBe(declared(one) === "exit 2" ? "exit 2" : "nothing");
    },
  );

  it("is read, and none of it is left out", () => {
    expect(cases.length).toBe(38);
  });
});

const ENTRY = {
  code: "DS1002",
  symbol: "ts://@example/app/src/lib.ts#helper",
  path: "src/lib.ts",
  reason: "Reached through the dispatcher's name table.",
};

describe("an ignore entry", () => {
  it("is reported at the line and column of the brace that opens it, in UTF-16 units", () => {
    const text = `{\n  "description": "\u{1F600}", "ignore": [ {"code": "DS1002", "symbol": "${ENTRY.symbol}", "reason": "x"},\n    ${JSON.stringify(ENTRY)}\n  ]\n}\n`;
    const held = readIgnoreFile(hostWith({ [IGNORE_FILE]: text }), ROOT, []);

    expect(held.refusals.map((one) => one.site)).toEqual([
      { path: IGNORE_FILE, line: 2, column: 36 },
    ]);
    expect(held.records.map((one) => one.site)).toEqual([
      { path: IGNORE_FILE, line: 3, column: 5 },
    ]);
  });

  it("that is refused is named once, at its own line and column, whatever its value", () => {
    const refused = (text: string): string => {
      try {
        readIgnoreFile(hostWith({ [IGNORE_FILE]: text }), ROOT, []);
        return "read";
      } catch (error: unknown) {
        return error instanceof ConfigError ? error.message : String(error);
      }
    };

    expect(refused(`{"ignore": [\n  null,\n  ${JSON.stringify(ENTRY)}\n]}`)).toBe(
      "ignore deadset-ignore.json:2:3: null: want an entry naming code, symbol, path and reason, each a string",
    );
    expect(refused(`{"ignore": [{"scope": "x"}]}`)).toMatch(
      /^ignore deadset-ignore\.json:1:13: the member "scope" is not one the grammar declares: want /u,
    );
  });

  it("binds only the declaration whose reference and file both equal the ones it names", () => {
    const named = declaration(ENTRY.symbol, ENTRY.path);
    const held = readIgnoreFile(
      hostWith({ [IGNORE_FILE]: JSON.stringify({ ignore: [ENTRY] }) }),
      ROOT,
      [
        declaration("ts://@example/app/src/other.ts#helper", "src/other.ts"),
        declaration("ts://@example/other/src/lib.ts#helper", "src/lib.ts", 9),
        named,
      ],
    );

    expect(held.records.map((one) => one.bound)).toEqual([named.id]);
  });

  it("binds a parameter's reference to the declaration that holds the parameter", () => {
    const named = declaration(ENTRY.symbol, ENTRY.path);
    const held = readIgnoreFile(
      hostWith({
        [IGNORE_FILE]: JSON.stringify({
          ignore: [{ ...ENTRY, code: "DS1801", symbol: `${ENTRY.symbol}(unread)` }],
        }),
      }),
      ROOT,
      [named],
    );

    expect(held.records.map((one) => [one.symbol, one.bound])).toEqual([
      [`${ENTRY.symbol}(unread)`, named.id],
    ]);
  });

  it("binds nothing through a parameter's reference under a code that is no part kind", () => {
    const held = readIgnoreFile(
      hostWith({
        [IGNORE_FILE]: JSON.stringify({
          ignore: [{ ...ENTRY, code: "DS1001", symbol: `${ENTRY.symbol}(unread)` }],
        }),
      }),
      ROOT,
      [declaration(ENTRY.symbol, ENTRY.path)],
    );

    expect(held.records.map((one) => [one.symbol, one.bound])).toEqual([
      [`${ENTRY.symbol}(unread)`, ""],
    ]);
  });

  it("names nothing when its path is another file than its reference's", () => {
    const held = readIgnoreFile(
      hostWith({ [IGNORE_FILE]: JSON.stringify({ ignore: [{ ...ENTRY, path: "src/other.ts" }] }) }),
      ROOT,
      [declaration(ENTRY.symbol, ENTRY.path)],
    );

    expect(held.records.map((one) => one.bound)).toEqual([""]);
  });
});

describe("a suppression document", () => {
  it.each([
    [
      "a member one object writes twice",
      `{"ignore": [{"code": "DS1002", "code": "DS1001", "symbol": "${ENTRY.symbol}"}]}`,
    ],
    ["a member the document does not declare", `{"ignore": [], "entries": []}`],
    ["no records array", `{"description": "nothing"}`],
    ["a description that is not a string", `{"description": 1, "ignore": []}`],
    ["a comment", `{"ignore": [] // none\n}`],
    ["a trailing comma", `{"ignore": [],}`],
  ])("holding %s ends the run with a usage refusal", (_what, text) => {
    expect(() => readIgnoreFile(hostWith({ [IGNORE_FILE]: text }), ROOT, [])).toThrow(ConfigError);
  });

  it("that is absent is an empty one", () => {
    expect(readBaseline(hostWith({}), ROOT, [])).toEqual({ records: [], refusals: [] });
  });
});

describe("a refused entry or document", () => {
  const refusalOf = (text: string): string => {
    try {
      return JSON.stringify(readIgnoreFile(hostWith({ [IGNORE_FILE]: text }), ROOT, []));
    } catch (error: unknown) {
      return error instanceof ConfigError ? error.message : `not a usage refusal: ${String(error)}`;
    }
  };

  it.each([
    ["null", "null"],
    ["a string", '"DS1002"'],
    ["an array", "[]"],
  ])("names an entry that is %s by its value", (_what, entry) => {
    expect(refusalOf(`{"ignore": [${entry}]}`)).toContain(
      `: ${entry}: want an entry naming code, symbol, path and reason, each a string`,
    );
  });

  it("names a member the grammar does not declare, though it holds a string", () => {
    expect(refusalOf(JSON.stringify({ ignore: [{ ...ENTRY, scope: "all" }] }))).toContain(
      `1:12: the member "scope" is not one the grammar declares: want an entry naming code, symbol, path and reason, each a string`,
    );
  });

  it("refuses a document that is null as no object", () => {
    expect(refusalOf("null")).toBe(
      `ignore ${IGNORE_FILE}: ${IGNORE_FILE}: want an object carrying the ignore array, and an optional description`,
    );
  });

  it("names why a document that is not JSON could not be parsed", () => {
    const text = '{"ignore": [}';
    let reason = "";
    try {
      JSON.parse(text);
    } catch (error: unknown) {
      reason = error instanceof Error ? error.message : String(error);
    }

    expect(refusalOf(text)).toBe(
      `ignore ${IGNORE_FILE}: ${IGNORE_FILE}: ${reason}: want an object carrying the ignore array, and an optional description`,
    );
  });
});

describe("a written baseline", () => {
  const recorded = [{ code: ENTRY.code, symbol: ENTRY.symbol, path: ENTRY.path }];

  it("is read back as one bound row per recorded finding, each carrying its provenance", () => {
    const text = whole(writeBaseline(recorded, { analyzer: "deadset-ts", version: "1.2.3" }));
    const held = readBaseline(hostWith({ [BASELINE_FILE]: text }), ROOT, [
      declaration(ENTRY.symbol, ENTRY.path),
    ]);

    expect(
      held.records.map((one) => [one.code, one.symbol, one.path, one.reason, one.bound]),
    ).toEqual([
      [ENTRY.code, ENTRY.symbol, ENTRY.path, "recorded by deadset-ts 1.2.3", "src/lib.ts:3:1"],
    ]);
    expect(held.refusals).toEqual([]);
  });

  it("is the same bytes for the same findings", () => {
    const provenance = { analyzer: "deadset-ts", version: "1.2.3" };

    expect(whole(writeBaseline(recorded, provenance))).toBe(
      whole(writeBaseline(recorded, provenance)),
    );
  });

  it("writes the line and paragraph separators as escapes and a lone surrogate as U+FFFD", () => {
    const kept = [
      {
        code: "DS1001",
        symbol: "go://example.com/app#Unused",
        path: "a\u2028b\u2029c.go",
        reason: "kept \ud800 here",
      },
    ];
    const text = whole(writeBaseline(recorded, { analyzer: "deadset-ts", version: "1.2.3" }, kept));

    expect(text).toContain(String.raw`"path": "a\u2028b\u2029c.go"`);
    expect(text).toContain(`"reason": "kept \ufffd here"`);
    expect(text).not.toMatch(/[\u2028\u2029]/u);
  });

  it("is refused where a row could carry no reason", () => {
    expect(() => writeBaseline(recorded, { analyzer: "deadset-ts", version: "" })).toThrow(
      /would carry no reason/u,
    );
    expect(() => writeBaseline(recorded, { analyzer: "", version: "1.2.3" })).toThrow(
      /would carry no reason/u,
    );
    for (const missing of ["code", "symbol"] as const) {
      expect(() =>
        writeBaseline([{ ...ENTRY, [missing]: "" }], { analyzer: "deadset-ts", version: "1.2.3" }),
      ).toThrow(/would carry no reason/u);
    }
    expect(() =>
      writeBaseline([{ ...recorded[0], path: "" } as (typeof recorded)[number]], {
        analyzer: "deadset-ts",
        version: "1.2.3",
      }),
    ).toThrow(/would carry no reason/u);
  });

  it("keeps the other language's rows as the document held them, before its own", () => {
    const provenance = { analyzer: "deadset-ts", version: "1.2.3" };
    const goRow = {
      code: "DS1001",
      symbol: "go://example.com/app#Catalog.ResolveAlias",
      path: "catalog.go",
      reason: "recorded by deadset-go 1.0.0",
    };
    const held = JSON.stringify({
      baseline: [
        { ...ENTRY, reason: "recorded by deadset-ts 1.0.0" },
        goRow,
        { ...goRow, symbol: "go://example.com/app#other" },
      ],
    });
    const written = JSON.parse(
      whole(writeBaseline(recorded, provenance, otherSchemeRows(held))),
    ) as { baseline: unknown[] };

    expect(written.baseline).toEqual([
      goRow,
      { ...goRow, symbol: "go://example.com/app#other" },
      { ...recorded[0], reason: "recorded by deadset-ts 1.2.3" },
    ]);
  });

  it("keeps a row of the other language missing its reason or its path with exactly the members it held", () => {
    const provenance = { analyzer: "deadset-ts", version: "1.2.3" };
    const unreasoned = { code: "DS1002", symbol: "go://example.com/app#gone", path: "main.go" };
    const unscoped = { code: "DS1002", symbol: "go://example.com/app#left", reason: "" };
    const written = whole(
      writeBaseline(
        [],
        provenance,
        otherSchemeRows(JSON.stringify({ baseline: [unreasoned, unscoped] })),
      ),
    );

    expect((JSON.parse(written) as { baseline: unknown[] }).baseline).toEqual([
      unreasoned,
      unscoped,
    ]);
    expect(written).toContain(JSON.stringify(unreasoned, undefined, 2).replaceAll("\n", "\n    "));
  });

  it("refuses to rewrite a document holding a row no record takes, of either language", () => {
    expect(() =>
      otherSchemeRows(`{"baseline": [{"code": "DS1", "symbol": "ts://@example/app/a.ts#A"}]}`),
    ).toThrow(/cannot be rewritten/u);
  });

  it("refuses to rewrite a document it cannot keep the other language's rows of", () => {
    expect(() => otherSchemeRows("{")).toThrow(/cannot be rewritten/u);
    expect(() => otherSchemeRows(`{"ignore": []}`)).toThrow(/cannot be rewritten/u);
    expect(() => otherSchemeRows(`{"baseline": [{"symbol": "go://example.com/app#x"}]}`)).toThrow(
      /cannot be rewritten/u,
    );
  });
});

describe("a record of the other language's scheme", () => {
  it("binds nothing, refuses nothing and is reported under no code in this analyzer", () => {
    const goEntry = { code: "DS1001", symbol: "go://example.com/app#Catalog", path: "catalog.go" };
    for (const [file, array, read] of [
      [IGNORE_FILE, "ignore", readIgnoreFile],
      [BASELINE_FILE, "baseline", readBaseline],
    ] as const) {
      const held = read(
        hostWith({
          [file]: JSON.stringify({ [array]: [goEntry, { ...goEntry, reason: "kept" }] }),
        }),
        ROOT,
        [declaration(goEntry.symbol, goEntry.path)],
      );

      expect(held).toEqual({ records: [], refusals: [] });
    }
  });

  it("still ends the run where a value is malformed", () => {
    const text = JSON.stringify({
      ignore: [{ code: "DS1001", symbol: "go://example.com/app#Catalog", path: "./catalog.go" }],
    });

    expect(() => readIgnoreFile(hostWith({ [IGNORE_FILE]: text }), ROOT, [])).toThrow(ConfigError);
  });
});
