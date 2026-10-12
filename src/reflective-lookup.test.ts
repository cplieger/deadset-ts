import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { fixture } from "../__test-helpers__/fixtures.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import { treeFindings } from "../__test-helpers__/tree-findings.ts";
import { runSweep, type RunSweep } from "./analysis.ts";
import { resolve } from "./resolve.ts";
import { run, type Writer } from "./run.ts";
import { scopeForDir } from "./scope.ts";
import { openEngine, type Engine } from "./session.ts";

const TARGET = fixture("projects", "named-members");

/** The fixture swept for production under its own configuration, with the shipped detectors. */
function sweepFixture(): RunSweep {
  const document = join(TARGET, "deadset.json");
  const { config } = resolve({
    repository: readFileSync(document, "utf8"),
    repositoryLabel: document,
  });
  const host = nodeHost();
  return runSweep(openEngine({ collectTiming: false }), host, scopeForDir(host, TARGET), config, {
    marked: [],
    mode: { production: true },
  });
}

class MemoryWriter implements Writer {
  text = "";
  write(text: string): void {
    this.text += text;
  }
}

describe("reflective lookup", () => {
  const swept = sweepFixture();

  it("retains each member a literal key of an element access or a global Reflect call spells, at the key, unless a typed key reads it", () => {
    expect(
      swept.retained
        .filter((held) => held.class === "reflective-lookup")
        .map((held) => {
          const name = swept.matrix.union.symbols.find((symbol) => symbol.id === held.id)?.name;
          return `${name ?? held.id} ${held.site.path}:${String(held.site.line)}:${String(held.site.column)} ${held.detail}`;
        }),
    ).toEqual([
      'Server.refresh src/main.ts:11:8 looked up by ["refresh"]',
      "Server.hidden src/main.ts:14:21 looked up by Reflect.has",
    ]);
  });

  it("holds back nothing a computed key, a local Reflect or a private name's spelling reaches", () => {
    const dead = swept.sweep.candidates.map(
      (candidate) =>
        swept.matrix.union.symbols.find((symbol) => symbol.id === candidate.id)?.name ?? "",
    );

    expect(dead).toContain("Server.restart");
    expect(dead).toContain("Server.#token");
  });
});

const SERVER = "export class Server {\n  restart(): void {}\n}\n";

function lookedUp(
  files: Readonly<Record<string, string>>,
  panicsOn?: (accessor: string, locations: readonly string[]) => boolean,
): string[] {
  const root = writeProject({
    "package.json": '{ "name": "app", "private": true, "type": "module", "main": "./main.ts" }\n',
    "server.ts": SERVER,
    ...files,
  });
  try {
    const { config } = resolve({
      repository: '{ "target": { "kind": "application" } }',
      repositoryLabel: "deadset.json",
    });
    const opened = openEngine({ collectTiming: false });
    const engine: Engine =
      panicsOn === undefined
        ? opened
        : {
            ...opened,
            ask: (accessor, locations, question) => {
              if (panicsOn(accessor, locations())) {
                throw new Error(`panic: ${accessor}`);
              }
              return opened.ask(accessor, locations, question);
            },
          };
    const host = nodeHost();
    const swept = runSweep(engine, host, scopeForDir(host, root), config, {
      marked: [],
      mode: { production: true },
    });
    return swept.retained
      .filter((held) => held.class === "reflective-lookup")
      .map((held) => {
        const name = swept.matrix.union.symbols.find((symbol) => symbol.id === held.id)?.name;
        return `${name ?? held.id} ${held.site.path}:${String(held.site.line)}:${String(held.site.column)} ${held.detail}`;
      });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("an element access with a literal key", () => {
  it("holds back nothing through a receiver whose type maps every string key", () => {
    expect(
      lookedUp({
        "main.ts": [
          'import { Server } from "./server.js";',
          "const handlers: Record<string, () => void> = {};",
          'handlers["restart"]?.();',
          "console.log(new Server());",
          "",
        ].join("\n"),
      }),
    ).toEqual([]);
  });

  it("retains what the key spells through a receiver typed any, though any answers every key", () => {
    expect(
      lookedUp({
        "main.ts": [
          'import { Server } from "./server.js";',
          "const loose: any = new Server();",
          'loose["restart"]();',
          "",
        ].join("\n"),
      }),
    ).toEqual(['Server.restart main.ts:3:7 looked up by ["restart"]']);
  });
});

describe("a keyed call on an object other than Reflect", () => {
  it("holds back nothing, though a global declared outside the project spells the call alike", () => {
    expect(
      lookedUp({
        "node_modules/registry/package.json": '{ "name": "registry", "types": "./index.d.ts" }\n',
        "node_modules/registry/index.d.ts":
          "export {};\ndeclare global {\n  const Registry: { get(target: object, key: string): unknown };\n}\n",
        "main.ts": [
          'import "registry";',
          'import { Server } from "./server.js";',
          'Registry.get(new Server(), "restart");',
          "",
        ].join("\n"),
      }),
    ).toEqual([]);
  });
});

describe("a Reflect call the checker cannot resolve", () => {
  // Asked alone, the name is the detector's own question: the reference pass asks it
  // in a batch, and an unanswered reference would keep the member live by itself.
  it("is read as the global Reflect, so it retains what its key spells", () => {
    const main = [
      'import { Server } from "./server.js";',
      'Reflect.has(new Server(), "restart");',
      "",
    ].join("\n");
    const reflect = `/main.ts:${String(main.indexOf("\nReflect"))}`;

    expect(
      lookedUp(
        { "main.ts": main },
        (accessor, locations) =>
          accessor === "getSymbolAtLocation" &&
          locations.length === 1 &&
          locations.every((at) => at.endsWith(reflect)),
      ),
    ).toEqual(["Server.restart main.ts:2:27 looked up by Reflect.has"]);
  });
});

describe("print-retained over a project whose templates and keys name members", () => {
  it("prints both low-confidence classes' records and exits 0", async () => {
    const out = new MemoryWriter();
    const err = new MemoryWriter();

    expect(run(["print-retained", `--target=${TARGET}`], out, err, nodeHost())).toBe(0);
    expect(err.text).toBe("");
    await expect(
      out.text,
      "regenerate with `npx vitest --run -u src/reflective-lookup.test.ts` and review the diff",
    ).toMatchFileSnapshot(fixture("golden", "named-members.retained.txt"));
  });
});

describe("a Reflect call where the project augments the global Reflect", () => {
  const found = treeFindings({
    "main.ts": [
      "class Server {",
      "  restart(): void {}",
      "}",
      'Reflect.has(new Server(), "restart");',
      "",
    ].join("\n"),
    "reflect.d.ts": [
      "export {};",
      "declare global {",
      "  namespace Reflect {",
      "    function trace(): void;",
      "  }",
      "}",
      "",
    ].join("\n"),
  });

  it("still reads the global Reflect, so the member its key spells is retained", () => {
    expect(found.filter((one) => one.includes("Server."))).toEqual([]);
  });
});
