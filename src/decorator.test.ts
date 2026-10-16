import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { fixture } from "../__test-helpers__/fixtures.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import { treeFindings } from "../__test-helpers__/tree-findings.ts";
import { runSweep, type RunSweep } from "./analysis.ts";
import { resolve } from "./resolve.ts";
import { run, type Writer } from "./run.ts";
import { scopeForDir } from "./scope.ts";
import { openEngine } from "./session.ts";

const TARGET = fixture("projects", "decorators");

/** The fixture swept for production, under its own configuration or the one given. */
function sweepFixture(document?: string): RunSweep {
  const path = join(TARGET, "deadset.json");
  const { config } = resolve({
    repository: { text: document ?? readFileSync(path, "utf8"), label: path },
  });
  const host = nodeHost();
  return runSweep(openEngine({ collectTiming: false }), host, scopeForDir(host, TARGET), config, {
    marked: [],
    mode: { production: true },
  });
}

/** The display name of one declaration of the run. */
function nameOf(swept: RunSweep, id: string): string {
  return swept.matrix.union.symbols.find((symbol) => symbol.id === id)?.name ?? id;
}

/** Each member the sweep reports dead, with the relation that found it. */
function deadMembers(swept: RunSweep): string[] {
  return swept.sweep.candidates
    .map((candidate) => `${nameOf(swept, candidate.id)} ${candidate.relation}`)
    .filter((line) => line.includes("."));
}

class MemoryWriter implements Writer {
  text = "";
  write(text: string): void {
    this.text += text;
  }
}

describe("decorator", () => {
  const swept = sweepFixture();

  it("retains each decorated member and every member of a decorated class, at the decorator", () => {
    expect(
      swept.retained.map(
        (held) =>
          `${nameOf(swept, held.id)} ${held.site.path}:${String(held.site.line)}:${String(held.site.column)} ${held.detail}`,
      ),
    ).toEqual([
      "Handlers.onStart src/handlers.ts:7:3 decorated by @register",
      "Handlers.label src/handlers.ts:10:3 decorated by @field",
      "Widget.render src/handlers.ts:16:1 decorated by @component",
      "Widget.state src/handlers.ts:16:1 decorated by @component",
      "Widget.create src/handlers.ts:16:1 decorated by @component",
    ]);
  });

  it("reports an undecorated member, a private name of a decorated class and a member of a plain class", () => {
    expect(deadMembers(swept)).toEqual([
      "Handlers.undecorated reference-counting",
      "Widget.#hidden reference-counting",
      "Plain.run reference-counting",
    ]);
  });

  it("counts the decorator's own use as a reference to what it decorates, with the class switched off", () => {
    const unexempt = sweepFixture(
      JSON.stringify({
        target: { kind: "application" },
        exemptions: { disabled: ["decorator"] },
      }),
    );

    expect(deadMembers(unexempt)).toEqual([
      "Handlers.onStart reachability",
      "Handlers.label reachability",
      "Handlers.undecorated reference-counting",
      "Widget.render reference-counting",
      "Widget.state reference-counting",
      "Widget.#hidden reference-counting",
      "Widget.create reference-counting",
      "Plain.run reference-counting",
    ]);
  });
});

describe("a parameter property of a decorated class", () => {
  it("is judged by its reads, the decorator holding back the class's other members", () => {
    expect(
      treeFindings({
        "main.ts": [
          "function component(_value: unknown, _context: ClassDecoratorContext): void {}",
          "@component",
          "class View {",
          "  constructor(private readonly dialog: string, private readonly title: string) {}",
          "  shown(): string { return this.title; }",
          "}",
          'console.log(new View("d", "t").shown());',
          "",
        ].join("\n"),
      }).filter((one) => one.includes("View.")),
    ).toEqual(["DS1301 View.dialog"]);
  });
});

describe("print-retained over a project whose classes carry decorators", () => {
  it("holds back the members of a decorated generic class, not its type parameters", () => {
    const root = writeProject({
      "package.json": '{ "name": "@example/boxes", "type": "module", "main": "./src/main.ts" }\n',
      "deadset.json": '{ "target": { "kind": "application" } }\n',
      "src/main.ts": [
        "function component<T>(value: T, _context: ClassDecoratorContext): T {",
        "  return value;",
        "}",
        "@component",
        "export class Box<Item> {",
        "  held?: Item;",
        "}",
        "console.log(Box);",
        "",
      ].join("\n"),
    });
    onTestFinished(() => {
      rmSync(root, { recursive: true, force: true });
    });
    const out = new MemoryWriter();

    expect(run(["print-retained", `--target=${root}`], out, new MemoryWriter(), nodeHost())).toBe(
      0,
    );
    expect(out.text.split("\n").filter((line) => line.includes("\tdecorator\t"))).toEqual([
      "ts://@example/boxes/src/main.ts#Box.held\tsrc/main.ts:6:3\tdecorator\tsrc/main.ts:4:1\tdecorated by @component",
    ]);
  });
  it("prints each decorated member with the decorator that holds it back, and exits 0", async () => {
    const out = new MemoryWriter();
    const err = new MemoryWriter();

    expect(run(["print-retained", `--target=${TARGET}`], out, err, nodeHost())).toBe(0);
    expect(err.text).toBe("");
    await expect(
      out.text,
      "regenerate with `npx vitest --run -u src/decorator.test.ts` and review the diff",
    ).toMatchFileSnapshot(fixture("golden", "decorators.retained.txt"));
  });
});
