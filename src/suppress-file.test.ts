import { describe, expect, it } from "vitest";
import { readFixture } from "../__test-helpers__/fixtures.ts";
import { ConfigError } from "./config.ts";
import type { Host } from "./host.ts";
import type { InventorySymbol } from "./inventory.ts";
import { joinPath } from "./paths.ts";
import {
  BASELINE_FILE,
  IGNORE_FILE,
  readBaseline,
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
    return held.records.length === 1 && held.records[0]?.bound !== "" ? "accepted" : "unbound";
  } catch (error: unknown) {
    return error instanceof ConfigError ? "exit 2" : String(error);
  }
}

describe("every entry and row case of the published token corpus", () => {
  const cases = CORPUS.filter((one) => one.kind !== "inline");

  it.each(cases.map((one) => [one.kind, JSON.stringify(one.input), one] as const))(
    "%s %s has the outcome the grammar declares",
    (_kind, _input, one) => {
      expect(outcome(one)).toBe(declared(one));
    },
  );

  it("is read, and none of it is left out", () => {
    expect(cases.length).toBe(25);
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

  it("is refused where a row could carry no reason", () => {
    expect(() => writeBaseline(recorded, { analyzer: "deadset-ts", version: "" })).toThrow(
      /would carry no reason/u,
    );
    expect(() =>
      writeBaseline([{ ...recorded[0], path: "" } as (typeof recorded)[number]], {
        analyzer: "deadset-ts",
        version: "1.2.3",
      }),
    ).toThrow(/would carry no reason/u);
  });
});
