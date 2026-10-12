import { rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import { inventory } from "./inventory.ts";
import type { Reference } from "./references.ts";
import { openEngine, runSession } from "./session.ts";
import { accessorsOf, storesOf } from "./stores.ts";

function reference(to: string, use: Reference["use"], test: boolean): Reference {
  return {
    from: "main.ts",
    to,
    position: { path: "main.ts", line: 1, column: 1 },
    use,
    resolution: "batch",
    test,
  };
}

describe("the class members declared by a getter or a setter", () => {
  it("are every accessor of the project's own files, and nothing else", () => {
    const root = writeProject({
      "main.ts":
        "export class Box {\n  size = 1;\n  get area(): number {\n    return 1;\n  }\n  set side(value: number) {}\n  grow(): void {}\n}\n",
    });
    try {
      const host = nodeHost();
      const { projects } = runSession(
        openEngine({ collectTiming: false }),
        [join(root, "tsconfig.json")],
        (project) => {
          const held = inventory(project, host, root);
          const names = new Map(held.symbols.map((symbol) => [symbol.id, symbol.name]));
          return accessorsOf(project, held).map((id) => names.get(id) ?? id);
        },
      );

      expect(projects).toEqual([["Box.area", "Box.side"]]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the declarations a test file reads", () => {
  it("are those a test file's read names, and not one it only writes or a production file reads", () => {
    const stores = storesOf(
      [
        {
          references: [
            reference("read-in-test", "read", true),
            reference("written-in-test", "write", true),
            reference("read-in-production", "read", false),
          ],
          accessors: [],
        },
      ],
      [],
      { production: true },
    );

    expect([...stores.readInTests]).toEqual(["read-in-test"]);
  });
});
