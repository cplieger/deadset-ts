import { describe, expect, it } from "vitest";
import { ConfigError, type Inputs } from "./config.ts";
import { resolve } from "./resolve.ts";

function refuse(inputs: Inputs): ConfigError {
  try {
    resolve(inputs);
  } catch (error: unknown) {
    if (error instanceof ConfigError) {
      return error;
    }
    throw error;
  }
  throw new Error("resolve accepted the inputs");
}

const LIBRARY = '{"target":{"kind":"library"}}';

function repository(text: string): Inputs {
  return { repository: text, repositoryLabel: "deadset.json" };
}

describe("the target kind", () => {
  it("is taken from the highest-ranked source that supplies one", () => {
    const { config, provenance } = resolve({
      repository: LIBRARY,
      repositoryLabel: "deadset.json",
      central: '{"target":{"kind":"application"}}',
      centralLabel: "central.json",
    });

    expect(config.targetKind).toBe("library");
    expect(provenance.get("target.kind")).toEqual({
      source: "repository",
      label: "deadset.json",
    });
  });

  it("resolves from the central configuration alone", () => {
    const { config, provenance } = resolve({
      central: '{"target":{"kind":"application"}}',
      centralLabel: "central.json",
    });

    expect(config.targetKind).toBe("application");
    expect(provenance.get("target.kind")?.source).toBe("central");
  });

  it("is refused naming the field when no source supplies one, with the sources searched", () => {
    const got = refuse(repository("{}"));

    expect(got.kind).toBe("missing-target-kind");
    expect(got.key).toBe("target.kind");
    expect(got.message).toContain("the repository configuration (deadset.json)");
    expect(got.message).toContain("the central configuration (not present)");
  });

  it("is never inferred", () => {
    const got = refuse(repository('{"analysis":{"languages":["ts"]}}'));

    expect(got.kind).toBe("missing-target-kind");
  });
});

describe("a severity key", () => {
  it.each([
    {
      name: "a code whose severity the Contract fixes",
      text: '{"target":{"kind":"library"},"severity":{"DS1703":"warn"}}',
      key: "severity.DS1703",
      names: "DS1703",
    },
    {
      name: "a family prefix whose range holds a fixed code",
      text: '{"target":{"kind":"library"},"severity":{"DS17":"allow"}}',
      key: "severity.DS17",
      names: "DS1703 and DS1704",
    },
    {
      name: "a key that is neither a code nor a family prefix",
      text: '{"target":{"kind":"library"},"severity":{"DS1":"warn"}}',
      key: "severity.DS1",
      names: "one issue-kind code or one two-digit family prefix",
    },
  ])("is refused when it names $name", ({ text, key, names }) => {
    const got = refuse(repository(text));

    expect(got.kind).toBe("unimplemented-key");
    expect(got.key).toBe(key);
    expect(got.message).toContain(names);
  });

  it("resolves per code, so a code only the central configuration names keeps its value", () => {
    const { config, provenance } = resolve({
      repository: '{"target":{"kind":"library"},"severity":{"DS1101":"allow"}}',
      repositoryLabel: "deadset.json",
      central: '{"severity":{"DS1101":"deny","DS1201":"warn"}}',
      centralLabel: "central.json",
    });

    expect([...config.severity]).toEqual([
      ["DS1101", "allow"],
      ["DS1201", "warn"],
    ]);
    expect(provenance.get("severity.DS1101")?.source).toBe("repository");
    expect(provenance.get("severity.DS1201")?.source).toBe("central");
  });

  it("carries one provenance entry for the object when it resolves empty", () => {
    const { provenance } = resolve(repository('{"target":{"kind":"library"},"severity":{}}'));

    expect(provenance.get("severity")).toEqual({ source: "repository", label: "deadset.json" });
    expect(provenance.has("severity.DS1101")).toBe(false);
  });
});

describe("a value the closed key list constrains", () => {
  it.each([
    {
      name: "a value outside a closed set",
      text: '{"target":{"kind":"module"}}',
      key: "target.kind",
      detail: '"module" is not one of "application", "library"',
    },
    {
      name: "a value of the wrong type",
      text: '{"target":{"kind":"library"},"consumers":{"complete":"yes"}}',
      key: "consumers.complete",
      detail: "is not a boolean",
    },
    {
      name: "a count below its minimum",
      text: '{"target":{"kind":"library"},"reporters":{"max_findings":-1}}',
      key: "reporters.max_findings",
      detail: "-1 is below the minimum of 0",
    },
    {
      name: "an array below its minimum length",
      text: '{"target":{"kind":"library"},"reporters":{"formats":[]}}',
      key: "reporters.formats",
      detail: "holds 0 entries, want at least 1",
    },
    {
      name: "an array naming one entry twice",
      text: '{"target":{"kind":"library"},"roots":{"patterns":["a","a"]}}',
      key: "roots.patterns",
      detail: 'names "a" twice',
    },
    {
      name: "an array holding an empty entry",
      text: '{"target":{"kind":"library"},"analysis":{"template_dirs":[""]}}',
      key: "analysis.template_dirs",
      detail: "holds an empty entry",
    },
    {
      name: "a contract version that is not a semantic version",
      text: '{"target":{"kind":"library"},"contract_version":"1.5"}',
      key: "contract_version",
      detail: '"1.5" is not a semantic version',
    },
    {
      name: "an exemption class that is not a class name",
      text: '{"target":{"kind":"library"},"exemptions":{"disabled":["Template Field"]}}',
      key: "exemptions.disabled",
      detail: '"Template Field" is not an exemption class name',
    },
    {
      name: "a build configuration naming no architecture",
      text:
        '{"target":{"kind":"library"},"analysis":{"configurations":' +
        '[{"id":"a","os":"linux","arch":""}]}}',
      key: "analysis.configurations[0].arch",
      detail: "is required and names nothing",
    },
  ])("is refused when it is $name", ({ text, key, detail }) => {
    const got = refuse(repository(text));

    expect(got.kind).toBe("malformed");
    expect(got.key).toBe(key);
    expect(got.message).toBe(`deadset.json: ${key}: ${detail}`);
  });

  it("is refused when the document is not JSON, naming the document", () => {
    const got = refuse(repository("{"));

    expect(got.kind).toBe("malformed");
    expect(got.message).toMatch(/^deadset\.json: /u);
  });
});

describe("a flag", () => {
  it("outranks both documents and names itself in the provenance", () => {
    const { config, provenance } = resolve({
      flags: '{"analysis.min_confidence":"certain"}',
      flagLabels: new Map([["analysis.min_confidence", "--min-confidence"]]),
      repository: '{"target":{"kind":"library"},"analysis":{"min_confidence":"probable"}}',
      repositoryLabel: "deadset.json",
    });

    expect(config.analysis.minConfidence).toBe("certain");
    expect(provenance.get("analysis.min_confidence")).toEqual({
      source: "flag",
      label: "--min-confidence",
    });
  });

  it("is refused when it names a path the closed key list does not declare", () => {
    const got = refuse({
      flags: '{"analysis.min_confidences":"certain"}',
      flagLabels: new Map(),
      repository: LIBRARY,
      repositoryLabel: "deadset.json",
    });

    expect(got.kind).toBe("unimplemented-key");
    expect(got.key).toBe("analysis.min_confidences");
  });

  it("is refused when a resolved setting came from a source that names no file or flag", () => {
    const got = refuse({
      flags: '{"analysis.min_confidence":"certain"}',
      repository: LIBRARY,
      repositoryLabel: "deadset.json",
    });

    expect(got.message).toContain("names no file or flag");
  });
});
