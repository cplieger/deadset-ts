import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { emitterInputOf, findingsOf } from "../__test-helpers__/emitter-input.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import { resolve } from "./resolve.ts";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * An application whose test reaches a loader with no test evidence through `importing`,
 * the loader exporting one function the test calls and two declarations nothing names,
 * beside a star re-export of the loader where `importing` names it.
 */
function project(importing: string): Readonly<Record<string, string>> {
  const barrel = importing.includes("support/index.js")
    ? { "support/index.ts": 'export * from "./loader.js";\n' }
    : {};
  return {
    ...barrel,
    "package.json": '{ "name": "@example/app", "type": "module", "main": "./main.ts" }\n',
    "main.ts": "console.log(1);\n",
    "support/loader.ts":
      "export function load(): number {\n  return 1;\n}\n\nexport const spare = 2;\n\nexport interface Extra {\n  readonly x: number;\n}\n",
    "loader.test.ts": `${importing}\n\nexport function testLoad(): boolean {\n  return load() > 0;\n}\n`,
  };
}

/** Every finding of the loader at `possible`, as `code name class confidence`. */
function loaderFindings(importing: string): string[] {
  const root = writeProject(project(importing));
  roots.push(root);
  const repository = JSON.stringify({
    target: { kind: "application" },
    analysis: { min_confidence: "possible" },
  });
  const { config } = resolve({ repository: { text: repository, label: "deadset.json" } });
  return findingsOf(emitterInputOf(root, config))
    .filter((finding) => finding.position.path === "support/loader.ts")
    .map(
      (finding) =>
        `${finding.code} ${finding.symbol.name} ${finding.reachabilityClass} ${finding.confidence}`,
    )
    .sort();
}

const EXPECTED = [
  "DS1001 spare certain certain",
  "DS1102 load possible possible",
  "DS1201 Extra certain certain",
];

describe("production code only tests use, reached through a whole module", () => {
  it("keeps what nothing names at its own class when the test imports through a star re-export", () => {
    expect(loaderFindings('import { load } from "./support/index.js";')).toEqual(EXPECTED);
  });

  it("keeps what nothing names at its own class when the test reads a namespace import", () => {
    expect(
      loaderFindings('import * as loader from "./support/loader.js";\n\nconst { load } = loader;'),
    ).toEqual(EXPECTED);
  });

  it("matches a test importing the loader directly", () => {
    expect(loaderFindings('import { load } from "./support/loader.js";')).toEqual(EXPECTED);
  });
});
