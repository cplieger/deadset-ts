import { rmSync } from "node:fs";
import { describe, expect, it, onTestFinished } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { analyzeProject, writeProject } from "../__test-helpers__/projects.ts";
import { run, type Writer } from "./run.ts";

const LOAD_TIMEOUT = 60_000;

const MANIFEST = `${JSON.stringify({
  name: "@example/lib",
  type: "module",
  exports: { ".": "./src/index.ts" },
})}\n`;

class MemoryWriter implements Writer {
  text = "";
  write(text: string): void {
    this.text += text;
  }
}

function published(files: Readonly<Record<string, string>>): string[] {
  const root = writeProject({
    "package.json": MANIFEST,
    "deadset.json": `${JSON.stringify({ target: { kind: "library" } })}\n`,
    ...files,
  });
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const out = new MemoryWriter();
  const err = new MemoryWriter();
  expect(run(["print-roots", `--target=${root}`], out, err, nodeHost()), err.text).toBe(0);
  return out.text
    .split("\n")
    .filter((line) => line.endsWith("\tpublished-api"))
    .map((line) => line.slice("ts://@example/lib/".length, -"\tpublished-api".length));
}

describe("the published API of a library", () => {
  it(
    "holds what a namespace re-export's module exports, and neither the module nor the types its statements write",
    () => {
      expect(
        published({
          "src/index.ts": 'export * as ns from "./other.js";\n',
          "src/other.ts": [
            "interface Written {",
            "  w: number;",
            "}",
            "export const shown = 1;",
            "const kept = 2;",
            "console.log(null as unknown as Written, kept);",
            "",
          ].join("\n"),
        }),
      ).toEqual(["src/index.ts#ns:alias", "src/other.ts#shown"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "holds no module a published declaration's type query names",
    () => {
      const names = published({
        "src/index.ts": [
          'import * as other from "./other.js";',
          "export const api: typeof other = other;",
          "",
        ].join("\n"),
        "src/other.ts": "export const shown = 1;\n",
      });

      expect(names).toContain("src/index.ts#api");
      expect(names).not.toContain("src/other.ts#");
    },
    LOAD_TIMEOUT,
  );

  it(
    "holds neither a private member nor a type parameter no published type writes",
    () => {
      expect(
        published({
          "src/index.ts": [
            "export class Box {",
            "  #secret = 1;",
            "  private count = 0;",
            "  open(): number {",
            "    return this.#secret + this.count;",
            "  }",
            "}",
            "export function make<Unused>(): Box {",
            "  return new Box();",
            "}",
            "",
          ].join("\n"),
        }),
      ).toEqual(["src/index.ts#Box", "src/index.ts#Box.open", "src/index.ts#make"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "holds what a type query and a recursive type of a published declaration name",
    () => {
      expect(
        published({
          "src/index.ts": [
            "const hidden = { h: 1 };",
            "export const alias: typeof hidden = hidden;",
            "interface Tree {",
            "  child: Tree;",
            "  leaf: Leaf;",
            "}",
            "interface Leaf {",
            "  size: number;",
            "}",
            "export function grow(): Tree {",
            '  throw new Error("unbuilt");',
            "}",
            "",
          ].join("\n"),
        }),
      ).toEqual([
        "src/index.ts#hidden",
        "src/index.ts#alias",
        "src/index.ts#Tree",
        "src/index.ts#Tree.child",
        "src/index.ts#Tree.leaf",
        "src/index.ts#Leaf",
        "src/index.ts#Leaf.size",
        "src/index.ts#grow",
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "holds the class and the interface a published class's heritage names",
    () => {
      expect(
        published({
          "src/index.ts": [
            "class Base {",
            "  base = 1;",
            "}",
            "interface Shape {",
            "  sides: number;",
            "}",
            "export class Square extends Base implements Shape {",
            "  sides = 4;",
            "}",
            "",
          ].join("\n"),
        }),
      ).toEqual([
        "src/index.ts#Base",
        "src/index.ts#Base.base",
        "src/index.ts#Shape",
        "src/index.ts#Shape.sides",
        "src/index.ts#Square",
        "src/index.ts#Square.sides",
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "holds the type a published getter returns",
    () => {
      expect(
        published({
          "src/index.ts": [
            "interface Reading {",
            "  level: number;",
            "}",
            "interface Setting {",
            "  level: number;",
            "}",
            "export class Panel {",
            "  #level = 0;",
            "  get reading(): Reading {",
            "    return { level: this.#level };",
            "  }",
            "  set reading(next: Setting) {",
            "    this.#level = next.level;",
            "  }",
            "}",
            "",
          ].join("\n"),
        }),
      ).toEqual(
        expect.arrayContaining([
          "src/index.ts#Reading",
          "src/index.ts#Reading.level",
          "src/index.ts#Panel.reading",
        ]),
      );
    },
    LOAD_TIMEOUT,
  );

  it(
    "holds, as guessed, every declaration spelled as a type name the checker leaves unanswered",
    () => {
      const text = [
        "export function take(value: Hidden, later: Promise<number>): void {",
        "  void value;",
        "  void later;",
        "}",
        "interface Hidden {",
        "  h: number;",
        "}",
        "",
      ].join("\n");
      const unanswered = new Set([text.indexOf(": Hidden") + 1, text.indexOf(": Promise") + 1]);
      const analyzed = analyzeProject(
        { "package.json": MANIFEST, "src/index.ts": text },
        {
          roots: { patterns: [], entryFiles: [], testFiles: [], publishedAPI: true },
          panicsOn: (accessor, locations) =>
            accessor === "getSymbolAtLocation" &&
            locations.some((location) =>
              [...unanswered].some((at) => location.endsWith(`/src/index.ts:${String(at)}`)),
            ),
        },
      );
      const refs = new Map(
        (analyzed.inventories[0]?.symbols ?? []).map((symbol) => [
          symbol.id,
          symbol.ref.slice("ts://@example/lib/src/index.ts#".length),
        ]),
      );
      const [rooted] = analyzed.roots;

      expect(rooted?.unanswered.map((id) => refs.get(id) ?? id)).toEqual(["Hidden"]);
      expect(
        rooted?.liveUnderReachability
          .filter((root) => root.kind === "published-api")
          .map((root) => refs.get(root.id) ?? root.id),
      ).toEqual(["take", "Hidden", "Hidden.h"]);
    },
    LOAD_TIMEOUT,
  );
});
