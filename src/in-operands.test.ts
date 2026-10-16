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

/** Each finding of an application at `possible`, as its code, subject, line and confidence. */
function findings(files: Readonly<Record<string, string>>): string[] {
  const root = writeProject({
    "package.json": '{ "name": "@example/app", "type": "module", "main": "./src/main.ts" }\n',
    ...files,
  });
  roots.push(root);
  const { config } = resolve({
    repository: {
      text: '{ "target": { "kind": "application" }, "analysis": { "min_confidence": "possible" } }',
      label: "deadset.json",
    },
  });
  return findingsOf(emitterInputOf(root, config)).map(
    ({ code, symbol, position, confidence }) =>
      `${code} ${symbol.name} ${String(position.line)} ${confidence}`,
  );
}

const READ_BACK =
  "interface Partial {\n  uploaded: string[];\n  skipped: string[];\n}\nexport const make = (u: string[]): unknown => ({ uploaded: u, skipped: u }) satisfies Partial;\n";

describe("a member an in expression tests by name", () => {
  it("is reported at possible at most, and a member no in expression names is not", () => {
    expect(
      findings({
        "src/main.ts": `${READ_BACK}export const read = (c: unknown): unknown =>\n  typeof c === "object" && c !== null && "uploaded" in c ? c.uploaded : [];\n`,
      }),
    ).toEqual(["DS1301 Partial.uploaded 2 possible", "DS1301 Partial.skipped 3 certain"]);
  });

  it("is not lowered by an in expression of a test file", () => {
    expect(
      findings({
        "src/main.ts": READ_BACK,
        "src/main.test.ts":
          'import { make } from "./main.js";\nconst c = make([]);\nif (typeof c === "object" && c !== null && "uploaded" in c) {\n  console.log(c.uploaded);\n}\n',
      }),
    ).toEqual(["DS1301 Partial.uploaded 2 certain", "DS1301 Partial.skipped 3 certain"]);
  });
});
