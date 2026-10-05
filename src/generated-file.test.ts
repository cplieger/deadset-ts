import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { emitterInputOf } from "../__test-helpers__/emitter-input.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import { findingsOf } from "./findings/emitters.ts";
import { resolve } from "./resolve.ts";

/** A project whose installed framework names `.nuxt` as the directory it generates. */
const PROJECT: Readonly<Record<string, string>> = {
  "package.json":
    '{ "name": "@example/app", "type": "module", "devDependencies": { "nuxt": "4.999.0" } }\n',
  "node_modules/nuxt/package.json": '{ "name": "nuxt", "version": "4.999.0" }\n',
  ".nuxt/routes.ts": 'export const routeName = "index";\n\nexport const unusedGenerated = 0;\n',
  "util.ts": "export const used = 1;\n\nexport const unusedWritten = 2;\n",
  "pages/index.ts":
    'import { routeName } from "../.nuxt/routes.js";\nimport { used } from "../util.js";\n\nconsole.log(routeName, used);\n',
};

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** The project analyzed with `analysis.generated_files` set to one value; the framework package itself is unused. */
function analyzed(generatedFiles: "exclude" | "include"): ReturnType<typeof emitterInputOf> {
  const root = writeProject(PROJECT);
  roots.push(root);
  const repository = JSON.stringify({
    target: { kind: "application" },
    analysis: { generated_files: generatedFiles },
  });
  const { config } = resolve({ repository, repositoryLabel: "deadset.json" });
  return emitterInputOf(root, config);
}

describe("the generated-file class", () => {
  it("retains each declaration below a directory an applied row names as generated, and reports the one beside it", () => {
    const input = analyzed("exclude");

    expect(
      findingsOf(input)
        .filter((finding) => finding.code !== "DS1601")
        .map((finding) => `${finding.code} ${finding.symbol.name}`),
    ).toEqual(["DS1001 unusedWritten"]);
    expect(
      input.swept.retained.map(
        (record) =>
          `${record.class} ${record.site.path}:${String(record.site.line)} ${record.detail}`,
      ),
    ).toEqual([
      "generated-file .nuxt/routes.ts:1 generated below a directory the convention row nuxt names",
    ]);
  });

  it("reports a declaration in a generated file once generated files are included, marked as one no edit may act on", () => {
    const found = findingsOf(analyzed("include"))
      .filter((finding) => finding.code !== "DS1601")
      .map(
        ({ code, symbol, generated, fixability }) =>
          `${code} ${symbol.name} generated=${String(generated)} ${fixability}`,
      );

    expect(found).toEqual([
      "DS1001 unusedGenerated generated=true none",
      "DS1001 unusedWritten generated=false deletable",
    ]);
  });
});
