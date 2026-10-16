import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { fixture } from "../__test-helpers__/fixtures.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import { runSweep, type RunSweep } from "./analysis.ts";
import { resolve } from "./resolve.ts";
import { run, type Writer } from "./run.ts";
import { scopeForDir } from "./scope.ts";
import { openEngine, type Engine } from "./session.ts";

const TARGET = fixture("projects", "reads-and-writes-enum-group");

class MemoryWriter implements Writer {
  text = "";
  write(text: string): void {
    this.text += text;
  }
}

function sweepRoot(
  root: string,
  panicsOn?: (accessor: string, locations: readonly string[]) => boolean,
): RunSweep {
  const { config } = resolve({
    repository: {
      text: JSON.stringify({ target: { kind: "application" } }),
      label: "deadset.json",
    },
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
  return runSweep(engine, host, scopeForDir(host, root), config, {
    marked: [],
    mode: { production: true },
  });
}

function nameOf(swept: RunSweep, id: string): string {
  return swept.matrix.union.symbols.find((symbol) => symbol.id === id)?.name ?? id;
}

function recorded(
  levels: string,
  main: string,
  panicsOn?: (accessor: string, locations: readonly string[]) => boolean,
): string[] {
  const root = writeProject({
    "package.json": '{ "name": "app", "private": true, "type": "module", "main": "./main.ts" }\n',
    "levels.ts": levels,
    "main.ts": main,
  });
  try {
    const swept = sweepRoot(root, panicsOn);
    return swept.exempt
      .filter((record) => record.class === "enum-group")
      .map(
        (record) =>
          `${nameOf(swept, record.id)} ${String(record.site.line)}:${String(record.site.column)} ${record.detail}`,
      );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("enum-group", () => {
  it("holds back each member a conversion can produce, with the conversion it found", () => {
    const swept = sweepRoot(TARGET);

    expect(
      swept.retained
        .filter((record) => record.class === "enum-group")
        .map((record) => `${nameOf(swept, record.id)} ${record.detail}`),
    ).toEqual([
      "Angle.B converted from number",
      "Named.Y converted from string",
      "Returned.Q converted from number",
      "Spaced.N1 looked up by an element access on Spaced",
      "Spaced.N2 looked up by an element access on Spaced",
    ]);
  });

  it("leaves dead a member of an enum looked up by literal keys or asserted from its own member", () => {
    const swept = sweepRoot(TARGET);

    expect(swept.sweep.candidates.map((candidate) => nameOf(swept, candidate.id))).toEqual([
      "Keyed.K2",
      "Self.S2",
    ]);
  });

  it("reads a conversion through parentheses, a qualified name and a namespace the enum sits in", () => {
    const levels = [
      "export enum Qualified { Q1, Q2 }",
      "export enum Wrapped { W1, W2 }",
      "export enum Looked { L1, L2 }",
      "export namespace Inner {",
      "  export enum Deep { D1, D2 }",
      "}",
      "export enum Empty {}",
      "",
    ].join("\n");
    const main = [
      'import * as levels from "./levels.js";',
      'import { Inner, Looked, Wrapped } from "./levels.js";',
      'const n = Number("1");',
      "console.log(<levels.Qualified>n, n as (Wrapped), (Looked)[n], n as Inner.Deep);",
      "console.log(n as levels.Empty);",
      "",
    ].join("\n");

    expect(recorded(levels, main)).toEqual([
      "Qualified.Q1 4:13 converted from number",
      "Qualified.Q2 4:13 converted from number",
      "Wrapped.W1 4:34 converted from number",
      "Wrapped.W2 4:34 converted from number",
      "Looked.L1 4:50 looked up by an element access on Looked",
      "Looked.L2 4:50 looked up by an element access on Looked",
      "Inner.Deep.D1 4:63 converted from number",
      "Inner.Deep.D2 4:63 converted from number",
    ]);
  });

  it("finds a value decoded from an unknown type, and none in a value that is never produced", () => {
    const levels = [
      "export enum Decoded { X1, X2 }",
      "export enum Never { V1, V2 }",
      "export function fail(): never {",
      '  throw new Error("no value");',
      "}",
      "",
    ].join("\n");
    const main = [
      'import { Decoded, fail, Never } from "./levels.js";',
      'const decoded: Decoded = JSON.parse("0");',
      "function never(): Never {",
      "  return fail();",
      "}",
      "console.log(decoded, never());",
      "",
    ].join("\n");

    expect(recorded(levels, main)).toEqual([
      "Decoded.X1 2:26 decoded as Decoded",
      "Decoded.X2 2:26 decoded as Decoded",
    ]);
  });

  it("finds no conversion in a string bound to a variable a string enum annotates", () => {
    const main = [
      'import { Named } from "./levels.js";',
      "const named: Named = String(1);",
      "console.log(named, Named.X);",
      "",
    ].join("\n");

    expect(recorded('export enum Named { X = "x", Y = "y" }\n', main)).toEqual([]);
  });

  it("names every enum a name spells where the checker does not say what the name is, and no other", () => {
    const levels =
      "export enum Angle { A, B }\nexport enum Other { O1, O2 }\nexport enum Third { T1, T2 }\n";
    const main = [
      'import * as levels from "./levels.js";',
      'import { Angle, Other } from "./levels.js";',
      'const n = Number("1");',
      "console.log(<Angle>n, n as levels.Third, Other.O1);",
      "",
    ].join("\n");
    const at = ["Angle>", " levels.Third", "Third,"].map(
      (needle) => `/main.ts:${String(main.indexOf(needle))}`,
    );

    expect(
      recorded(
        levels,
        main,
        (accessor, locations) =>
          accessor === "getSymbolAtLocation" &&
          locations.some((one) => at.some((location) => one.endsWith(location))),
      ),
    ).toEqual([
      "Angle.A 4:13 converted from number",
      "Angle.B 4:13 converted from number",
      "Third.T1 4:23 converted from number",
      "Third.T2 4:23 converted from number",
    ]);
  });
});

describe("print-retained over a project whose enums each conversion form produces", () => {
  it("prints each member held back with its conversion, and exits 0", async () => {
    const out = new MemoryWriter();
    const err = new MemoryWriter();

    expect(run(["print-retained", `--target=${TARGET}`], out, err, nodeHost())).toBe(0);
    expect(err.text).toBe("");
    await expect(
      out.text,
      "regenerate with `npx vitest --run -u src/enum-group.test.ts` and review the diff",
    ).toMatchFileSnapshot(fixture("golden", "reads-and-writes-enum-group.retained.txt"));
  });
});
