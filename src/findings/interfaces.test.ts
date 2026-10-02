import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emitterInputOf } from "../../__test-helpers__/emitter-input.ts";
import { fixture } from "../../__test-helpers__/fixtures.ts";
import { resolve } from "../resolve.ts";
import type { EmitterInput } from "./emitter.ts";
import { EMITTERS } from "./emitters.ts";

const TARGET = fixture("projects", "interfaces");

/** What a test reads of one finding of the whole table. */
interface Reported {
  readonly code: string;
  readonly symbol: { readonly ref: string; readonly kind: string; readonly name: string };
  readonly position: { readonly path: string; readonly line: number };
  readonly message: string;
  readonly details?: {
    readonly implementations?: readonly {
      readonly ref: string;
      readonly name: string;
      readonly position: { readonly path: string; readonly line: number };
    }[];
  };
}

/** The fixture's emitter input, swept for production under its own configuration. */
function emitterInput(): EmitterInput {
  const path = join(TARGET, "deadset.json");
  const { config } = resolve({ repository: readFileSync(path, "utf8"), repositoryLabel: path });
  return emitterInputOf(TARGET, config);
}

/** Every finding the emitter table produces, of every family, as a report would read it. */
function everyFinding(input: EmitterInput): Reported[] {
  return [...EMITTERS.values()].flatMap(
    (emit) => JSON.parse(JSON.stringify(emit(input))) as Reported[],
  );
}

/** The findings of the interfaces family alone. */
function family(input: EmitterInput): Reported[] {
  const emit = EMITTERS.get("interfaces");
  return emit === undefined ? [] : (JSON.parse(JSON.stringify(emit(input))) as Reported[]);
}

/** One line per finding: code, display name, and the implementations it names. */
function lines(findings: readonly Reported[]): string[] {
  return findings.map(
    (found) =>
      `${found.code} ${found.symbol.name} [${(found.details?.implementations ?? [])
        .map((one) => one.name)
        .join(", ")}]`,
  );
}

/** The display names of every finding of every family. */
function namesReported(findings: readonly Reported[]): string[] {
  return findings.map((found) => found.symbol.name);
}

describe("the interfaces emitter", () => {
  const input = emitterInput();
  const reported = everyFinding(input);

  it("is the committed golden finding list", async () => {
    await expect(
      `${JSON.stringify(family(input), null, 2)}\n`,
      "the list is produced by the production path; to record a reviewed change run " +
        "`npx vitest --run -u src/findings/interfaces.test.ts` and read the diff as production code",
    ).toMatchFileSnapshot(fixture("golden", "interfaces.findings.json"));
  });

  it("reports each unused interface and each uncalled method of a used one, with the implementations", () => {
    expect(lines(family(input))).toEqual([
      "DS1201 Unused [Runner]",
      "DS1201 OnlyDead []",
      "DS1203 Channel.close [Wire, Pipe]",
      "DS1203 Signal.raise [Flag, Arrowed]",
      "DS1203 Listener.notify []",
      "DS1201 Probe []",
    ]);
  });

  it("names where each implementation is written", () => {
    const close = family(input).find((found) => found.symbol.name === "Channel.close");

    expect(
      (close?.details?.implementations ?? []).map(
        (one) => `${one.ref} ${one.position.path}:${String(one.position.line)}`,
      ),
    ).toEqual([
      "ts://@example/interfaces/src/classes.ts#Wire src/classes.ts:11",
      "ts://@example/interfaces/src/classes.ts#Pipe src/classes.ts:23",
    ]);
  });

  it("says why each unused interface is unused", () => {
    expect(
      family(input)
        .filter((found) => found.code === "DS1201")
        .map((found) => `${found.symbol.name}: ${found.message}`),
    ).toEqual([
      "Unused: nothing in the target names the interface as a type",
      "OnlyDead: the interface is named as a type only from declarations that are themselves dead",
      "Probe: the interface is named as a type only from test files",
    ]);
  });

  it("reports no member of an unused interface under any code, and places each in its component", () => {
    expect(namesReported(reported)).not.toContain("Unused.run");
    expect(namesReported(reported)).not.toContain("Unused.label");
    expect(namesReported(reported)).not.toContain("OnlyDead.go");

    const union = input.swept.matrix.union;
    const named = (ids: readonly string[]): string[] =>
      ids.map((id) => union.symbols[union.at(id)]?.name ?? id);
    const held = input.swept.sweep.components.find((component) =>
      named(component.members).includes("Unused"),
    );
    expect(named(held?.members ?? [])).toEqual(["Unused", "Unused.run", "Unused.label"]);
    expect(named(held?.roots ?? [])).toEqual(["Unused"]);
  });

  it("reports nothing about an interface with one implementation and a use as a type", () => {
    for (const name of ["Seam", "Seam.act", "Worker", "Worker.act"]) {
      expect(namesReported(reported), name).not.toContain(name);
    }
  });

  it("reports nothing about a method whose every implementation has an empty body", () => {
    for (const name of ["Channel.ping", "Box.seal", "Hook.fire", "Quiet.fire", "Crate.seal"]) {
      expect(namesReported(reported), name).not.toContain(name);
    }
  });

  it("reports nothing about a method called through its interface", () => {
    for (const name of ["Channel.send", "Box.open"]) {
      expect(namesReported(reported), name).not.toContain(name);
    }
  });

  it.each([
    ["a test file", "Gauge.measure"],
    ["a declaration that is itself dead", "Gauge.reset"],
  ])("reports nothing about a method of a used interface called only from %s", (_from, name) => {
    expect(namesReported(family(input))).not.toContain(name);
  });

  it("reports no declaration of a test file", () => {
    expect(namesReported(family(input))).not.toContain("TestDouble");
  });
});
