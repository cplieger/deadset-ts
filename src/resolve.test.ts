import { describe, expect, it } from "vitest";
import {
  contractDocument,
  negativeDocument,
  negatives,
  type Negative,
} from "../__test-helpers__/fixtures.ts";
import { refusedPlace } from "../__test-helpers__/refusal.ts";
import type { Inputs } from "./config.ts";
import { CONFIG_MAX_BYTES, SETTINGS, type SettingRow } from "./contract/config.generated.ts";
import { EXEMPTION_CLASSES } from "./contract/contract.generated.ts";
import { dotted, placeIn, pointerSegments } from "./json-document.ts";
import { printConfig } from "./print.ts";
import { resolve, resolvePartial } from "./resolve.ts";
import { firstRefusal } from "./schema.ts";
import { UsageError } from "./usage.ts";

function refusal(run: () => unknown): UsageError {
  try {
    run();
  } catch (error: unknown) {
    if (error instanceof UsageError) {
      return error;
    }
    throw error;
  }
  throw new Error("resolution accepted the inputs");
}

const refuse = (inputs: Inputs): UsageError => refusal(() => resolve(inputs));

function repository(document: unknown): Inputs {
  const text = typeof document === "string" ? document : JSON.stringify(document);
  return { repository: { text, label: "deadset.json" } };
}

/** A repository configuration naming the target kind, beside the given members. */
const library = (members: Record<string, unknown> = {}): Inputs =>
  repository({ target: { kind: "library" }, ...members });

describe("the target kind", () => {
  it("is taken from the highest-ranked source that supplies one", () => {
    const { config, provenance } = resolve({
      repository: { text: '{"target":{"kind":"library"}}', label: "deadset.json" },
      central: { text: '{"target":{"kind":"application"}}', label: "central.json" },
    });

    expect(config.target.kind).toBe("library");
    expect(provenance.get("target.kind")).toEqual({ source: "repository", label: "deadset.json" });
  });

  it("resolves from the central configuration alone", () => {
    const { config, provenance } = resolve({
      central: { text: '{"target":{"kind":"application"}}', label: "central.json" },
    });

    expect(config.target.kind).toBe("application");
    expect(provenance.get("target.kind")).toEqual({ source: "central", label: "central.json" });
  });

  it("is refused naming the key when no source supplies one, with the sources searched", () => {
    const got = refuse(repository({ analysis: { min_confidence: "certain" } }));

    expect(refusedPlace(got.message)).toBe("target.kind");
    expect(got.message).toBe(
      "target.kind is not set, it has no default and is never inferred: searched " +
        "the repository configuration (deadset.json) and the central configuration (not present)",
    );
  });

  it("is required by no question that asks none", () => {
    expect(resolvePartial(repository({})).target.kind).toBeUndefined();
    expect(resolvePartial({}).analysis.configurations).toEqual([]);
  });
});

describe("a target kind written per language", () => {
  it("is read as this analyzer's member alone, another language's member unread", () => {
    const { config, provenance } = resolve(
      repository({ target: { kind: { go: "service", ts: "library" } } }),
    );

    expect(config.target.kind).toEqual({ ts: "library" });
    expect(provenance.get("target.kind")?.source).toBe("repository");
  });

  it.each([
    { kind: { go: null, ts: "application" } },
    { kind: { go: ["application"], ts: "application" } },
  ])("accepts another language's member of any value: %j", (target) => {
    expect(resolve(repository({ target })).config.target.kind).toEqual({ ts: "application" });
  });

  it.each([
    [{ go: "library" }, "target.kind.ts", "deadset.json: target.kind.ts: is required and absent"],
    [
      { ts: "module" },
      "target.kind.ts",
      'deadset.json: target.kind.ts: "module" is not one of "application", "library"',
    ],
    [
      { py: "library", ts: "library" },
      "target.kind.py",
      'deadset.json: key "target.kind.py" is not implemented',
    ],
  ])("refuses %j at %s", (kind, key, message) => {
    const got = refuse(repository({ target: { kind } }));

    expect(refusedPlace(got.message)).toBe(key);
    expect(got.message).toBe(message);
  });
});

/** The keys of the rows whose default their own value schema refuses. */
function refusedDefaults(rows: readonly SettingRow[]): string[] {
  return rows
    .filter((row) => row.default !== undefined)
    .filter((row) =>
      row.role === "keyed"
        ? Object.values(row.default as object).some(
            (member: unknown) => firstRefusal(row.value ?? {}, member) !== undefined,
          )
        : firstRefusal(row.value ?? {}, row.default) !== undefined,
    )
    .map((row) => row.key);
}

describe("a default the table carries", () => {
  it("is one its own value schema admits", () => {
    const planted: SettingRow = {
      key: "planted",
      role: "keyed",
      read: true,
      default: { A: 1 },
      value: { type: "string" },
    };

    expect(refusedDefaults([planted])).toEqual(["planted"]);
    expect(refusedDefaults(SETTINGS)).toEqual([]);
  });
});

describe("a key only another product reads", () => {
  /** Every key the generated table says this analyzer's language does not read. */
  const unread = SETTINGS.filter((row) => !row.read).map((row) => row.key);

  it("is one the table names", () => {
    expect(unread).toEqual(["analysis.languages", "providers", "providers.analyzers", "go"]);
  });

  it.each(unread)("is accepted unread, whatever %s holds", (key) => {
    const document: Record<string, unknown> = { target: { kind: "library" } };
    const names = key.split(".");
    let into = document;
    for (const name of names.slice(0, -1)) {
      into = (into[name] ??= {}) as Record<string, unknown>;
    }
    into[names.at(-1) ?? key] = { planted: [null], "a.b": "" };

    const { config, provenance } = resolve(repository(document));

    expect(provenance.has(key)).toBe(false);
    expect(printConfig(config, provenance)).not.toContain("planted");
  });

  it("is accepted unread beside a refusal of its own the orchestrator makes", () => {
    const { config } = resolve(
      library({
        analysis: { languages: ["py"] },
        providers: {
          analyzers: [
            { name: "deadset-ts", languages: ["ts"], command: "a" },
            { name: "deadset-ts", languages: ["ts"], command: "b" },
          ],
        },
        go: { planted: true, build_tags: "not-a-list" },
      }),
    );

    expect(Object.keys(config)).not.toContain("providers");
    expect(Object.keys(config)).not.toContain("go");
    expect(Object.keys(config.analysis)).not.toContain("languages");
  });
});

describe("a severity key", () => {
  it.each([
    ["DS9003", "the Contract fixes the severity of DS9003, which this key names"],
    ["DS90", "the Contract fixes the severity of DS9003, DS9004 and DS9006, which this key names"],
    ["DS1", "the name does not match ^DS[0-9]{2}([0-9]{2})?$"],
    ["DS1999", "no issue kind carries the code DS1999"],
    ["DS1801", "no issue kind carries the code DS1801"],
    ["DS18", "no issue kind carries a code of the family DS18"],
  ])("refuses %s as unimplemented, saying why", (code, why) => {
    const got = refuse(library({ severity: { [code]: "warn" } }));

    expect(refusedPlace(got.message)).toBe(`severity.${code}`);
    expect(got.message).toBe(`deadset.json: key "severity.${code}" is not implemented: ${why}`);
  });

  it("refuses a severity outside the severities", () => {
    expect(refusedPlace(refuse(library({ severity: { DS1501: "fatal" } })).message)).toBe(
      "severity.DS1501",
    );
  });

  it("is refused at the first key in ascending order, whatever order the document writes them", () => {
    expect(
      refusedPlace(refuse(library({ severity: { DS1999: "warn", DS1: "warn" } })).message),
    ).toBe("severity.DS1");
  });

  it("resolves per code over every source, in ascending order", () => {
    const { config, provenance } = resolve({
      repository: {
        text: '{"target":{"kind":"library"},"severity":{"DS1501":"allow"}}',
        label: "deadset.json",
      },
      central: { text: '{"severity":{"DS1501":"deny","DS1201":"warn"}}', label: "central.json" },
    });

    expect(Object.entries(config.severity)).toEqual([
      ["DS1201", "warn"],
      ["DS1501", "allow"],
    ]);
    expect(provenance.get("severity.DS1501")?.source).toBe("repository");
    expect(provenance.get("severity.DS1201")?.source).toBe("central");
    expect(provenance.has("severity")).toBe(false);
  });

  it("accepts a live kind of another language and a family prefix holding a live kind", () => {
    const { config } = resolve(library({ severity: { DS1702: "warn", DS14: "allow" } }));

    expect(Object.entries(config.severity)).toEqual([
      ["DS14", "allow"],
      ["DS1702", "warn"],
    ]);
  });

  it("carries one provenance entry for the object when it resolves empty", () => {
    const { provenance } = resolve(library({ severity: {} }));

    expect(provenance.get("severity")).toEqual({ source: "repository", label: "deadset.json" });
  });
});

describe("a value the closed key list constrains", () => {
  it.each([
    [{ consumers: { complete: "yes" } }, "consumers.complete", "the value is string, want boolean"],
    [{ reporters: { max_findings: -1 } }, "reporters.max_findings", "-1 is below 0"],
    [{ reporters: { formats: [] } }, "reporters.formats", "the array holds 0 items, fewer than 1"],
    [{ roots: { patterns: ["a", "a"] } }, "roots.patterns", "the array lists one value twice"],
    [
      { analysis: { template_dirs: [""] } },
      "analysis.template_dirs[0]",
      '"" is shorter than 1 characters',
    ],
    [
      { contract_version: "1.5" },
      "contract_version",
      '"1.5" does not match ^[0-9]+\\.[0-9]+\\.[0-9]+$',
    ],
    [
      { analysis: { min_confidence: null } },
      "analysis.min_confidence",
      "the value is null, want string",
    ],
    [
      { analysis: { configurations: [{ id: "a", os: "linux", arch: "amd64" }, { id: "b" }] } },
      "analysis.configurations[1].project",
      "is required and absent",
    ],
    [
      { ts: { lifecycle_contracts: [{ bases: [{ global: "HTMLElement" }] }] } },
      "ts.lifecycle_contracts[0].members",
      "is required and absent",
    ],
    [
      { ts: { serializers: [{ module: "./wire.ts", name: "encode" }] } },
      "ts.serializers[0].module",
      '"./wire.ts" does not match ^[^./#]',
    ],
    [{ target: "library" }, "target", "the value is string, want object"],
    [{ provenance: [] }, "provenance", "the value is array, want object"],
  ])("refuses %j at %s", (members, key, detail) => {
    const got = refuse(library(members));

    expect(refusedPlace(got.message)).toBe(key);
    expect(got.message).toBe(`deadset.json: ${key}: ${detail}`);
  });

  it("names the values a vocabulary setting admits in its refusal", () => {
    const got = refuse(library({ exemptions: { disabled: ["enum-group", "Template Field"] } }));

    expect(refusedPlace(got.message)).toBe("exemptions.disabled[1]");
    expect(got.message).toBe(
      'deadset.json: exemptions.disabled[1]: "Template Field" is not one of ' +
        EXEMPTION_CLASSES.map((row) => JSON.stringify(row.class)).join(", "),
    );
  });

  it("refuses an exemption class outside the vocabulary where no target kind is asked", () => {
    expect(
      refusedPlace(
        refusal(() => resolvePartial(repository({ exemptions: { disabled: ["no-such-class"] } })))
          .message,
      ),
    ).toBe("exemptions.disabled[0]");
  });

  it("refuses a disabled convention naming no row this analyzer carries", () => {
    const got = refuse(library({ ts: { disabled_conventions: ["no-such-convention"] } }));

    expect(refusedPlace(got.message)).toBe("ts.disabled_conventions[0]");
    expect(got.message).toContain('"no-such-convention" names no row this analyzer carries');
  });

  it.each(["100.0", "1e2", "1.5E1"])("refuses an integer written %s", (written) => {
    const got = refuse(
      repository(`{"target":{"kind":"library"},"reporters":{"max_findings":${written}}}`),
    );

    expect(got.message).toBe(
      `deadset.json: reporters.max_findings: holds ${written}, ` +
        "want an integer written as an optional minus sign and digits alone",
    );
  });
});

describe("one configuration document", () => {
  it("is refused when it is not JSON, at the line and column of the fault", () => {
    const got = refuse(repository("{\n  x"));

    expect(refusedPlace(got.message)).toBe("");
    expect(got.message).toBe("deadset.json: line 2, column 3: a member name is expected");
  });

  it.each([
    ['{"0":1,"0":2}', 'deadset.json: 0: line 1, column 8: the member "0" is written twice'],
    [
      '{"target":{"kind":"library"},"analysis":{"template_delimiters":{"left":"[","right":"]","0":"|"}}}',
      'deadset.json: key "analysis.template_delimiters.0" is not implemented',
    ],
    [
      '{"target":{"kind":{"ts":"library","0":"x"}}}',
      'deadset.json: key "target.kind.0" is not implemented',
    ],
  ])("names a member spelled in digits as a member: %s", (text, message) => {
    expect(refuse(repository(text)).message).toMatch(new RegExp(`^${RegExp.escape(message)}`, "u"));
  });

  it("is refused when it is JSON but not one object", () => {
    expect(refuse(repository("[]")).message).toBe("deadset.json: is not one JSON object");
  });

  it.each([
    ['{"severity":{},"severity":{}}', "severity"],
    [
      '{"analysis":{"min_confidence":"certain","min_confidence":"possible"}}',
      "analysis.min_confidence",
    ],
    ['{"target":{"kind":"library"},"\\u0074arget":{}}', "target"],
    [
      '{"analysis":{"configurations":[{"id":"a"} , {"id":"b","id":"c"}]}}',
      "analysis.configurations[1].id",
    ],
    ['{"go":{"tags":[],"tags":[]}}', "go.tags"],
  ])("refuses %s for the member it writes twice, at any depth", (text, key) => {
    const got = refuse(repository(text));

    expect(refusedPlace(got.message)).toBe(key);
    expect(got.message).toContain("is written twice, so neither value is chosen");
  });

  it.each([
    [{ reporters: { fail_under: "warn" } }, "reporters.fail_under", ""],
    [{ ts: { planted: 1 } }, "ts.planted", ""],
    [
      { analysis: { template_delimiters: { left: "[", right: "]", middle: "|" } } },
      "analysis.template_delimiters.middle",
      "",
    ],
    [
      { analysis: { configurations: [{ id: "a", os: "l", arch: "a", project: "p" }] } },
      "analysis.configurations[0].project",
      "",
    ],
    [
      { "analysis.min_confidence": "certain" },
      "analysis.min_confidence",
      ": it is one setting, written as nested objects",
    ],
  ])("refuses %j for the key the list does not declare", (members, key, why) => {
    const got = refuse(library(members));

    expect(refusedPlace(got.message)).toBe(key);
    expect(got.message).toBe(`deadset.json: key ${JSON.stringify(key)} is not implemented${why}`);
  });

  it("is refused above the Contract's bound, before it is decoded", () => {
    const text = `{"roots":{"patterns":["${"a".repeat(CONFIG_MAX_BYTES)}"]}}`;

    expect(refuse(repository(text)).message).toBe(
      `deadset.json: holds more than ${String(CONFIG_MAX_BYTES)} bytes`,
    );
  });

  it("names the central configuration by its own label", () => {
    const got = refuse({
      repository: { text: '{"target":{"kind":"library"}}', label: "deadset.json" },
      central: { text: '{"target":"library"}', label: "/etc/deadset.json" },
    });

    expect(got.message).toBe("/etc/deadset.json: target: the value is string, want object");
  });
});

describe("a flag", () => {
  it("outranks both documents and names its option in the provenance", () => {
    const { config, provenance } = resolve({
      flags: new Map([["analysis.min_confidence", "certain"]]),
      repository: {
        text: '{"target":{"kind":"library"},"analysis":{"min_confidence":"probable"}}',
        label: "deadset.json",
      },
    });

    expect(config.analysis.min_confidence).toBe("certain");
    expect(provenance.get("analysis.min_confidence")).toEqual({
      source: "flag",
      label: "--min-confidence",
    });
  });

  it("supplies an integer written as digits, and is refused naming its option otherwise", () => {
    const flags = (text: string): Inputs => ({
      ...library(),
      flags: new Map([["reporters.max_findings", text]]),
    });

    expect(resolve(flags("25")).config.reporters.max_findings).toBe(25);
    expect(refuse(flags("1e2")).message).toBe(
      "--max-findings: reporters.max_findings: the value is string, want integer",
    );
  });

  it("is refused naming its option when its value is refused", () => {
    const got = refuse({ ...library(), flags: new Map([["reporters.sort", "random"]]) });

    expect(refusedPlace(got.message)).toBe("reporters.sort");
    expect(got.message).toBe('--sort: reporters.sort: "random" is not one of "position", "size"');
  });

  it("is refused where no option supplies the setting it names", () => {
    const got = refuse({ ...library(), flags: new Map([["roots.patterns", "x"]]) });

    expect(got.message).toBe(
      'the command line: key "roots.patterns" is not implemented: no flag supplies it',
    );
  });
});

describe("the build matrix", () => {
  it("holds each entry as written, its members in ascending order", () => {
    const { config } = resolve(
      repository(
        '{"target":{"kind":"application"},"analysis":{"configurations":[' +
          '{"os":"linux","id":"linux-amd64","arch":"amd64"},' +
          '{"project":"packages/app/tsconfig.json","id":"app"}]}}',
      ),
    );

    expect(config.analysis.configurations).toEqual([
      { id: "linux-amd64", os: "linux", arch: "amd64" },
      { id: "app", project: "packages/app/tsconfig.json" },
    ]);
    expect(config.analysis.configurations.map((entry) => Object.keys(entry))).toEqual([
      ["arch", "id", "os"],
      ["id", "project"],
    ]);
  });

  /** The pattern the Contract's configuration schema gives a project entry's path. */
  function projectPattern(): string {
    const analysis = (
      contractDocument("config.schema.json")["properties"] as Record<string, unknown>
    )["analysis"] as { properties: Record<string, { items: { oneOf: readonly unknown[] } }> };
    const project = analysis.properties["configurations"]?.items.oneOf.find((shape) =>
      (shape as { required: readonly string[] }).required.includes("project"),
    ) as { properties: { project: { pattern: string } } } | undefined;
    return project?.properties.project.pattern ?? "";
  }

  it.each([
    "tsconfig.json",
    "packages/app/tsconfig.json",
    ".config/tsconfig.json",
    "..hidden/tsconfig.json",
    "./tsconfig.json",
    "../tsconfig.json",
    "/abs/tsconfig.json",
    "a//tsconfig.json",
    "a\\tsconfig.json",
    "a\ntsconfig.json",
    "src/routes/(app)/+layout/tsconfig.json",
    ".",
    "a/..",
  ])("admits the project path %j exactly when the Contract's pattern does", (project) => {
    const admitted = new RegExp(projectPattern(), "u").test(project);
    const inputs = repository({
      target: { kind: "application" },
      analysis: { configurations: [{ id: "p", project }] },
    });

    let accepted = true;
    try {
      resolve(inputs);
    } catch (error: unknown) {
      if (!(error instanceof UsageError)) {
        throw error;
      }
      accepted = false;
    }

    expect(accepted, `resolve over the project ${JSON.stringify(project)}`).toBe(admitted);
  });
});

describe("a declaration the ts section names", () => {
  it("is held as the entry writes it, in the order the document lists them", () => {
    const serializers = [
      { symbol: "ts://@example/app/src/wire.ts#encode" },
      { module: "@example/codec", name: "Codec.write:static" },
      { global: "structuredClone" },
    ];

    expect(resolve(library({ ts: { serializers } })).config.ts.serializers).toEqual(serializers);
  });

  it.each([
    { serializers: [{ symbol: "ts://./a.ts#f", global: "f" }] },
    { serializers: [{}] },
    { lifecycle_contracts: [{ components: [], bases: [], members: ["render"] }] },
  ])("refuses an entry matching no shape: %j", (ts) => {
    const got = refuse(library({ ts }));

    expect(refusedPlace(got.message)).toMatch(/^ts\.[a-z_]+\[0\]$/u);
  });
});

/** The dotted key a row's instance path names, and whether this analyzer reads it. */
function placeOf(row: Negative): { place: string; read: boolean } {
  const segments = pointerSegments(row.instance_path).filter((one) => !/^[0-9]+$/u.test(one));
  let read = true;
  for (let length = 1; length <= segments.length; length += 1) {
    const held = SETTINGS.find((setting) => setting.key === segments.slice(0, length).join("."));
    read &&= held?.read ?? true;
  }
  return {
    place: dotted(placeIn(JSON.parse(negativeDocument(row.file)), row.instance_path)),
    read,
  };
}

describe("the Contract's refused configuration documents", () => {
  it("holds a refused document of a key this analyzer does not read", () => {
    expect(
      negatives("contract/config.schema.json").filter((row) => !placeOf(row).read),
    ).not.toEqual([]);
  });

  it.each(negatives("contract/config.schema.json"))(
    "answers $file as its language reads it",
    (row) => {
      const inputs = repository(negativeDocument(row.file));
      const { place, read } = placeOf(row);
      if (!read) {
        expect(() => resolvePartial(inputs)).not.toThrow();
        return;
      }
      const at = refusedPlace(refusal(() => resolvePartial(inputs)).message);

      expect(
        at === place || at.startsWith(`${place}.`) || at.startsWith(`${place}[`),
        `${at} is at or inside ${place}`,
      ).toBe(true);
    },
  );
});
