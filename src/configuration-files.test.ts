import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { emitterInputOf } from "../__test-helpers__/emitter-input.ts";
import { fixture } from "../__test-helpers__/fixtures.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import { runRoots } from "./analysis.ts";
import {
  configurationModuleForm,
  dependenciesNamed,
  documentStrings,
  isConfigurationDocumentName,
} from "./configuration-files.ts";
import { EMITTERS } from "./findings/emitters.ts";
import { resolve } from "./resolve.ts";
import { scopeForDir } from "./scope.ts";
import { openEngine } from "./session.ts";

const TARGET = fixture("projects", "configuration-files");

/** The fixture's configuration, resolved from its own document. */
function configOf(target: string): ReturnType<typeof resolve> {
  const document = join(target, "deadset.json");
  return resolve({ repository: readFileSync(document, "utf8"), repositoryLabel: document });
}

/** Every file root of the fixture a configuration rule makes, as `path kind source`. */
const FILE_ROOTS = ((): string[] => {
  const host = nodeHost();
  const { config, provenance } = configOf(TARGET);
  const answer = runRoots(
    openEngine({ collectTiming: false }),
    host,
    scopeForDir(host, TARGET),
    config,
    provenance,
  );
  return answer.roots
    .filter((root) => root.kind.startsWith("configuration-") && root.ref.endsWith("#"))
    .map((root) => `${root.position.path} ${root.kind} ${root.source}`);
})();

/** The declared dependencies of the fixture the target does not need, by name. */
const UNUSED = ((): string[] => {
  const emit = EMITTERS.get("dependencies-and-module-machinery");
  const input = emitterInputOf(TARGET, configOf(TARGET).config);
  return emit === undefined ? [] : emit(input).map((finding) => finding.symbol.name);
})();

describe("the names of configuration files", () => {
  it.each([
    ["vite.config.ts", "<stem>.config.<ext>"],
    ["my-tool.config.mts", "<stem>.config.<ext>"],
    ["tool_2.config.cjs", "<stem>.config.<ext>"],
    ["vitest.stryker.config.js", "<stem>.<qualifier>.config.<ext>"],
    ["app.e2e-ci.config.cts", "<stem>.<qualifier>.config.<ext>"],
    [".eslintrc.cjs", ".<stem>rc.<ext>"],
    [".prettierrc.mjs", ".<stem>rc.<ext>"],
    [".babelrc.js", ".<stem>rc.<ext>"],
  ])("reads %s as a configuration module of the form %s", (name, form) => {
    expect(configurationModuleForm(name)).toBe(form);
  });

  it.each([
    "vite.config.json",
    "vite.config.d.ts",
    "vite.config.tsx",
    "three.part.name.config.ts",
    "tool.configs.ts",
    ".tool.config.ts",
    ".toolrc.ts",
    ".rc.js",
    "tool config.ts",
  ])("reads %s as no configuration module", (name) => {
    expect(configurationModuleForm(name)).toBeUndefined();
  });

  it.each(["tool.config.json", "tool.lint.config.json", ".toolrc", ".toolrc.json"])(
    "reads %s as a JSON configuration file",
    (name) => {
      expect(isConfigurationDocumentName(name)).toBe(true);
    },
  );

  it.each([
    "tool.config.jsonc",
    ".toolrc.yaml",
    "package.json",
    "tsconfig.json",
    "three.part.name.config.json",
    "tool.config.ts",
  ])("reads %s as no JSON configuration file", (name) => {
    expect(isConfigurationDocumentName(name)).toBe(false);
  });
});

describe("the strings of a JSON configuration file", () => {
  it("are its string values at any depth, and never a member's name", () => {
    expect(
      documentStrings({
        "member-name": "value",
        list: ["first", { deep: "second" }],
        number: 1,
        flag: true,
        empty: null,
      }),
    ).toEqual(["value", "first", "second"]);
  });
});

describe("a string that names a dependency", () => {
  const declared = ["dep", "dep-other", "@scope/name"];

  it.each([
    ["dep", ["dep"]],
    ["dep/sub/path", ["dep"]],
    ["dep-other", ["dep-other"]],
    ["@scope/name", ["@scope/name"]],
    ["@scope/name/sub", ["@scope/name"]],
    ["depx", []],
    ["dep-other-tool", []],
    ["@scope", []],
    ["./dep", []],
  ])("reads %s as a use of %j", (text, used) => {
    expect(dependenciesNamed(text, declared)).toEqual(used);
  });
});

describe("the configuration files of a project", () => {
  it("root each configuration module and each own file a string of a configuration file names", () => {
    expect(FILE_ROOTS).toEqual([
      ".toolrc.cjs configuration-file .<stem>rc.<ext>",
      "src/bare.ts configuration-string ./src/bare",
      "src/emitted.ts configuration-string ./src/emitted.js",
      "src/json-list.ts configuration-string ./src/json-list.ts",
      "src/json-value.ts configuration-string ./src/json-value.ts",
      "src/named.ts configuration-string ./src/named.ts",
      "src/qualified.ts configuration-string ./src/qualified.ts",
      "src/rc-json.ts configuration-string ./src/rc-json.ts",
      "src/rc-module.ts configuration-string ./src/rc-module.ts",
      "src/template.ts configuration-string ./src/template.ts",
      "src/unprefixed.ts configuration-string src/unprefixed.ts",
      "src/up.ts configuration-string ../src/up.ts",
      "sub/inner.config.ts configuration-file <stem>.config.<ext>",
      "tool.config.ts configuration-file <stem>.config.<ext>",
      "tool.lint.config.mts configuration-file <stem>.<qualifier>.config.<ext>",
    ]);
  });

  it.each([
    ["src/pattern-one.ts", "a string holding a wildcard"],
    ["src/substituted.ts", "a template literal with a substitution"],
    ["src/no-manifest.ts", "a string of a configuration name in a directory with no manifest"],
    [
      "src/no-manifest-json.ts",
      "a string of a JSON configuration name in a directory with no manifest",
    ],
    ["src/too-many-parts.ts", "a string of a name with two qualifiers"],
    ["src/configs.ts", "a string of a name that is no configuration form"],
    ["src/rc-typescript.ts", "a string of an rc module with a TypeScript extension"],
    ["src/broken.ts", "a string of a JSON configuration file that does not parse"],
  ])("roots nothing for %s, %s", (path) => {
    expect(FILE_ROOTS.filter((line) => line.startsWith(`${path} `))).toEqual([]);
  });

  it("uses each dependency the manifest beside a configuration file declares that one of its strings spells", () => {
    expect(UNUSED).toEqual([
      "dep-broken",
      "dep-member",
      "dep-nested",
      "dep-nested-json",
      "dep-prefix",
      "dep-root-only",
      "dep-substituted",
    ]);
  });
});

describe("a configuration file no program holds", () => {
  it("reads the modules it imports by a relative specifier and no other file it imports", () => {
    const root = writeProject({
      "package.json":
        '{ "name": "@example/app", "type": "module", "main": "./src/main.ts", "devDependencies": { "@example/kit": "1.0.0", "@example/used": "1.0.0" } }\n',
      "src/main.ts": "export const main = 1;\n",
      "tool.config.mjs":
        'import manifest from "./package.json" with { type: "json" };\nimport shared from "./tool.shared.mjs";\nexport default [manifest.name, ...shared];\n',
      "tool.shared.mjs": 'import used from "@example/used";\nexport default [used];\n',
    });
    try {
      const { config } = resolve({
        repository: '{ "target": { "kind": "application" } }',
        repositoryLabel: "deadset.json",
      });
      const emit = EMITTERS.get("dependencies-and-module-machinery");
      const unused =
        emit === undefined
          ? []
          : emit(emitterInputOf(root, config)).map((finding) => finding.symbol.name);
      expect(unused).toEqual(["@example/kit"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
