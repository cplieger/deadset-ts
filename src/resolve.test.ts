import { describe, expect, it } from "vitest";
import { contractDocument } from "../__test-helpers__/fixtures.ts";
import { ConfigError, type Inputs } from "./config.ts";
import { resolve, resolveMatrix } from "./resolve.ts";

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
      setting: "severity.DS1703",
      names: "DS1703",
    },
    {
      name: "a family prefix whose range holds a fixed code",
      text: '{"target":{"kind":"library"},"severity":{"DS17":"allow"}}',
      setting: "severity.DS17",
      names: "DS1703 and DS1704",
    },
    {
      name: "a key that is neither a code nor a family prefix",
      text: '{"target":{"kind":"library"},"severity":{"DS1":"warn"}}',
      setting: "severity.DS1",
      names: "one issue-kind code or one two-digit family prefix",
    },
  ])("is refused when it names $name", ({ text, setting, names }) => {
    const got = refuse(repository(text));

    expect(got.kind).toBe("unimplemented-key");
    expect(got.key).toBe(setting);
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
      setting: "target.kind",
      detail: '"module" is not one of "application", "library"',
    },
    {
      name: "a value of the wrong type",
      text: '{"target":{"kind":"library"},"consumers":{"complete":"yes"}}',
      setting: "consumers.complete",
      detail: "is not a boolean",
    },
    {
      name: "a count below its minimum",
      text: '{"target":{"kind":"library"},"reporters":{"max_findings":-1}}',
      setting: "reporters.max_findings",
      detail: "-1 is below the minimum of 0",
    },
    {
      name: "an array below its minimum length",
      text: '{"target":{"kind":"library"},"reporters":{"formats":[]}}',
      setting: "reporters.formats",
      detail: "holds 0 entries, want at least 1",
    },
    {
      name: "an array naming one entry twice",
      text: '{"target":{"kind":"library"},"roots":{"patterns":["a","a"]}}',
      setting: "roots.patterns",
      detail: 'names "a" twice',
    },
    {
      name: "an array holding an empty entry",
      text: '{"target":{"kind":"library"},"analysis":{"template_dirs":[""]}}',
      setting: "analysis.template_dirs",
      detail: "holds an empty entry",
    },
    {
      name: "a contract version that is not a semantic version",
      text: '{"target":{"kind":"library"},"contract_version":"1.5"}',
      setting: "contract_version",
      detail: '"1.5" is not a semantic version',
    },
    {
      name: "an exemption class that is not a class name",
      text: '{"target":{"kind":"library"},"exemptions":{"disabled":["Template Field"]}}',
      setting: "exemptions.disabled",
      detail: '"Template Field" is not an exemption class name',
    },
    {
      name: "a build configuration naming no architecture",
      text:
        '{"target":{"kind":"library"},"analysis":{"configurations":' +
        '[{"id":"a","os":"linux","arch":""}]}}',
      setting: "analysis.configurations[0].arch",
      detail: "is required and names nothing",
    },
    {
      name: "a build configuration carrying the members of a platform and of a project",
      text:
        '{"target":{"kind":"application"},"analysis":{"configurations":' +
        '[{"id":"tsconfig.json","os":"linux","arch":"amd64","project":"tsconfig.json"}]}}',
      setting: "analysis.configurations[0]",
      detail:
        'carries "os", "arch" of a platform and "project" of a project, ' +
        "and an entry is one shape or the other",
    },
    {
      name: "a build configuration carrying the members of neither shape",
      text:
        '{"target":{"kind":"application"},"analysis":{"configurations":' +
        '[{"id":"a","os":"linux","arch":"amd64"},{"id":"b"}]}}',
      setting: "analysis.configurations[1]",
      detail: 'names neither a platform\'s "os" and "arch" nor a project\'s "project"',
    },
    {
      name: "a project naming a file outside the target root",
      text:
        '{"target":{"kind":"application"},"analysis":{"configurations":' +
        '[{"id":"up","project":"../tsconfig.json"}]}}',
      setting: "analysis.configurations[0].project",
      detail:
        '"../tsconfig.json" is not a path below the target root: segments joined by /, ' +
        "none empty, . or .., and no backslash or line break",
    },
    {
      name: "a project naming no file",
      text:
        '{"target":{"kind":"application"},"analysis":{"configurations":' +
        '[{"id":"none","project":""}]}}',
      setting: "analysis.configurations[0].project",
      detail: "is required and names nothing",
    },
  ])("is refused when it is $name", ({ text, setting, detail }) => {
    const got = refuse(repository(text));

    expect(got.kind).toBe("malformed");
    expect(got.key).toBe(setting);
    expect(got.message).toBe(`deadset.json: ${setting}: ${detail}`);
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

describe("the build matrix", () => {
  it("reads each entry as the shape its members name, in the order the document lists them", () => {
    const { config } = resolve(
      repository(
        '{"target":{"kind":"application"},"analysis":{"configurations":[' +
          '{"id":"linux-amd64","os":"linux","arch":"amd64"},' +
          '{"id":"app","project":"packages/app/tsconfig.json"}]}}',
      ),
    );

    expect(config.analysis.configurations).toEqual([
      { shape: "platform", id: "linux-amd64", os: "linux", arch: "amd64", tags: [] },
      { shape: "project", id: "app", project: "packages/app/tsconfig.json" },
    ]);
  });

  it.each([
    "tsconfig.json",
    "packages/app/tsconfig.json",
    ".config/tsconfig.json",
    "..hidden/tsconfig.json",
    "a/..b/tsconfig.json",
    "C:/tsconfig.json",
    "./tsconfig.json",
    "../tsconfig.json",
    "/abs/tsconfig.json",
    "a//tsconfig.json",
    "packages/app/",
    "a/./tsconfig.json",
    "a/../tsconfig.json",
    "a\\tsconfig.json",
    "a\ntsconfig.json",
    "tsconfig.json\r",
    ".",
    "..",
    "a/..",
  ])("admits the project path %j exactly when the Contract's pattern does", (project) => {
    const admitted = new RegExp(projectPattern(), "u").test(project);
    const document = JSON.stringify({
      target: { kind: "application" },
      analysis: { configurations: [{ id: "p", project }] },
    });

    let accepted = true;
    try {
      resolve(repository(document));
    } catch (error: unknown) {
      if (!(error instanceof ConfigError)) {
        throw error;
      }
      accepted = false;
    }

    expect(accepted, `resolve over the project ${JSON.stringify(project)}`).toBe(admitted);
  });
});

describe("the build matrix on its own", () => {
  it("resolves from documents that name no target kind", () => {
    expect(
      resolveMatrix(
        repository('{"analysis":{"configurations":[{"id":"app","project":"tsconfig.json"}]}}'),
      ),
    ).toEqual([{ shape: "project", id: "app", project: "tsconfig.json" }]);
  });

  it("is the empty default where no document names one", () => {
    expect(resolveMatrix({})).toEqual([]);
  });

  it("refuses a document resolution refuses, naming the same key", () => {
    let thrown: unknown;
    try {
      resolveMatrix(repository('{"analysis":{"configurations":[{"id":"x"}]}}'));
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigError);
    expect(thrown instanceof ConfigError ? thrown.key : "").toBe("analysis.configurations[0]");
  });
});

/** A repository configuration whose `ts` section is the given object. */
function tsSection(ts: unknown): Inputs {
  return repository(JSON.stringify({ target: { kind: "application" }, ts }));
}

describe("a declaration the ts section names", () => {
  it("is read as the one shape its members name, in the order the document lists them", () => {
    const { config } = resolve(
      tsSection({
        serializers: [
          { symbol: "ts://@example/app/src/wire.ts#encode" },
          { module: "@example/codec", name: "Codec.write:static" },
          { global: "structuredClone" },
        ],
      }),
    );

    expect(config.ts.serializers).toEqual([
      { shape: "symbol", symbol: "ts://@example/app/src/wire.ts#encode" },
      { shape: "module", module: "@example/codec", name: "Codec.write:static" },
      { shape: "global", global: "structuredClone" },
    ]);
  });

  it("leaves a lifecycle contract's components or bases empty where the entry omits them", () => {
    const { config } = resolve(
      tsSection({
        lifecycle_contracts: [
          { bases: [{ global: "HTMLElement" }], members: ["connectedCallback"] },
          { components: [{ module: "@example/ui", name: "element" }], members: ["render"] },
        ],
      }),
    );

    expect(config.ts.lifecycleContracts).toEqual([
      {
        components: [],
        bases: [{ shape: "global", global: "HTMLElement" }],
        members: ["connectedCallback"],
      },
      {
        components: [{ shape: "module", module: "@example/ui", name: "element" }],
        bases: [],
        members: ["render"],
      },
    ]);
  });

  it.each([
    {
      name: "an entry carrying the members of two shapes",
      ts: { injection_registrations: [{ symbol: "ts://./a.ts#f", global: "f" }] },
      setting: "ts.injection_registrations[0]",
      detail:
        'carries "symbol", "global", which is not one of "symbol", "module" with "name", or "global"',
    },
    {
      name: "an entry naming no declaration",
      ts: { serializers: [{}] },
      setting: "ts.serializers[0]",
      detail: 'names no declaration: an entry carries "symbol", "module" with "name", or "global"',
    },
    {
      name: "a declaration path named without its module",
      ts: { serializers: [{ name: "encode" }] },
      setting: "ts.serializers[0]",
      detail: 'carries "name", which is not one of "symbol", "module" with "name", or "global"',
    },
    {
      name: "a relative module specifier",
      ts: { serializers: [{ module: "./wire.ts", name: "encode" }] },
      setting: "ts.serializers[0].module",
      detail:
        '"./wire.ts" is not a bare specifier: a file of the analyzed program is named by its symbol',
    },
    {
      name: "a specifier the package's imports field maps",
      ts: { serializers: [{ module: "#wire", name: "encode" }] },
      setting: "ts.serializers[0].module",
      detail:
        '"#wire" is not a bare specifier: a file of the analyzed program is named by its symbol',
    },
    {
      name: "a symbol spelled outside the TypeScript reference form",
      ts: { serializers: [{ symbol: "go://example.com/app#Encode" }] },
      setting: "ts.serializers[0].symbol",
      detail: '"go://example.com/app#Encode" is not a ts:// reference',
    },
    {
      name: "a global path that names nothing",
      ts: { serializers: [{ global: "" }] },
      setting: "ts.serializers[0].global",
      detail: "is required and names nothing",
    },
    {
      name: "a lifecycle contract naming no member",
      ts: { lifecycle_contracts: [{ bases: [{ global: "HTMLElement" }], members: [] }] },
      setting: "ts.lifecycle_contracts[0].members",
      detail: "holds 0 entries, want at least 1",
    },
    {
      name: "a lifecycle contract leaving its members out",
      ts: { lifecycle_contracts: [{ bases: [{ global: "HTMLElement" }] }] },
      setting: "ts.lifecycle_contracts[0].members",
      detail: "is required and names nothing",
    },
    {
      name: "a lifecycle contract whose component and base lists are both empty",
      ts: { lifecycle_contracts: [{ components: [], bases: [], members: ["render"] }] },
      setting: "ts.lifecycle_contracts[0]",
      detail:
        'names no declaration in "components" and no class in "bases", so it makes no class a component',
    },
  ])("is refused when it is $name", ({ ts, setting, detail }) => {
    const got = refuse(tsSection(ts));

    expect(got.kind).toBe("malformed");
    expect(got.key).toBe(setting);
    expect(got.message).toBe(`deadset.json: ${setting}: ${detail}`);
  });

  it.each([
    {
      file: "ts-injection-registration-unknown-member.json",
      text: '{"contract_version":"3.1.0","target":{"kind":"application"},"ts":{"injection_registrations":[{"module":"@example/container","name":"Container.bind","argument":0}]}}',
      kind: "unimplemented-key",
      key: "ts.injection_registrations[0].argument",
    },
    {
      file: "ts-lifecycle-contract-framework-name.json",
      text: '{"contract_version":"3.1.0","target":{"kind":"application"},"ts":{"lifecycle_contracts":[{"framework":"elements","components":[{"global":"CustomElementRegistry.define"}],"members":["connectedCallback"]}]}}',
      kind: "unimplemented-key",
      key: "ts.lifecycle_contracts[0].framework",
    },
    {
      file: "ts-lifecycle-contract-no-component-route.json",
      text: '{"contract_version":"3.1.0","target":{"kind":"application"},"ts":{"lifecycle_contracts":[{"members":["connectedCallback"]}]}}',
      kind: "malformed",
      key: "ts.lifecycle_contracts[0]",
    },
    {
      file: "ts-serializer-unknown-member.json",
      text: '{"contract_version":"3.1.0","target":{"kind":"application"},"ts":{"serializers":[{"global":"structuredClone","returns":"string"}]}}',
      kind: "unimplemented-key",
      key: "ts.serializers[0].returns",
    },
  ])(
    "refuses the Contract's refused document $file at the entry it names",
    ({ text, kind, key }) => {
      const got = refuse(repository(text));

      expect(got.kind).toBe(kind);
      expect(got.key).toBe(key);
    },
  );
});
