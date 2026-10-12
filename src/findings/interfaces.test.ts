import { mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emitterInputOf } from "../../__test-helpers__/emitter-input.ts";
import { fixture } from "../../__test-helpers__/fixtures.ts";
import { writeProject } from "../../__test-helpers__/projects.ts";
import { resolve } from "../resolve.ts";
import { openEngine, type Engine } from "../session.ts";
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
  it("is the committed golden finding list", async () => {
    await expect(
      `${JSON.stringify(family(emitterInput()), null, 2)}\n`,
      "the list is produced by the production path; to record a reviewed change run " +
        "`npx vitest --run -u src/findings/interfaces.test.ts` and read the diff as production code",
    ).toMatchFileSnapshot(fixture("golden", "interfaces.findings.json"));
  });

  it("reports each unused interface and each uncalled method of a used one, with the implementations", () => {
    expect(lines(family(emitterInput()))).toEqual([
      "DS1201 Unused [Runner]",
      "DS1201 OnlyDead []",
      "DS1203 Channel.close [Wire, Pipe]",
      "DS1203 Signal.raise [Flag, Arrowed]",
      "DS1203 Listener.notify []",
      "DS1201 Probe []",
    ]);
  });

  it("names where each implementation is written", () => {
    const close = family(emitterInput()).find((found) => found.symbol.name === "Channel.close");

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
      family(emitterInput())
        .filter((found) => found.code === "DS1201")
        .map((found) => `${found.symbol.name}: ${found.message}`),
    ).toEqual([
      "Unused: nothing in the target names the interface as a type",
      "OnlyDead: the interface is named as a type only from declarations that are themselves dead",
      "Probe: the interface is named as a type only from test files",
    ]);
  });

  it("reports no member of an unused interface under any code, and places each in its component", () => {
    const input = emitterInput();
    const reported = namesReported(everyFinding(input));
    expect(reported).not.toContain("Unused.run");
    expect(reported).not.toContain("Unused.label");
    expect(reported).not.toContain("OnlyDead.go");

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
    const reported = namesReported(everyFinding(emitterInput()));
    for (const name of ["Seam", "Seam.act", "Worker", "Worker.act"]) {
      expect(reported, name).not.toContain(name);
    }
  });

  it("reports nothing about a method whose every implementation has an empty body", () => {
    const reported = namesReported(everyFinding(emitterInput()));
    for (const name of ["Channel.ping", "Box.seal", "Hook.fire", "Quiet.fire", "Crate.seal"]) {
      expect(reported, name).not.toContain(name);
    }
  });

  it("reports nothing about a method called through its interface", () => {
    const reported = namesReported(everyFinding(emitterInput()));
    for (const name of ["Channel.send", "Box.open"]) {
      expect(reported, name).not.toContain(name);
    }
  });

  it.each([
    ["a test file", "Gauge.measure"],
    ["a declaration that is itself dead", "Gauge.reset"],
  ])("reports nothing about a method of a used interface called only from %s", (_from, name) => {
    expect(namesReported(family(emitterInput()))).not.toContain(name);
  });

  it("reports no declaration of a test file", () => {
    expect(namesReported(family(emitterInput()))).not.toContain("TestDouble");
  });
});

function reportedOver(main: string, panics = false): string[] {
  const root = writeProject({
    "package.json":
      '{ "name": "@example/channels", "private": true, "type": "module", "bin": "./src/main.ts" }\n',
    "src/main.ts": main,
  });
  const opened = openEngine({ collectTiming: false });
  const engine: Engine = {
    ...opened,
    ask: (accessor, locations, question) => {
      if (panics && accessor === "isTypeAssignableTo") {
        throw new Error(`panic: ${accessor}`);
      }
      return opened.ask(accessor, locations, question);
    },
  };
  try {
    const { config } = resolve({
      repository: '{ "target": { "kind": "application" } }',
      repositoryLabel: "deadset.json",
    });
    return lines(family(emitterInputOf(root, config, { engine })));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const CHANNEL = [
  "interface Channel {",
  "  send(): void;",
  "  close(): void;",
  "}",
  "",
  "class Wire {",
  "  send(): void {",
  '    console.log("send");',
  "  }",
  "  close(): void {",
  '    console.log("close");',
  "  }",
  "}",
  "",
].join("\n");

describe("an uncalled method of an interface a class matches by shape", () => {
  it("is reported with the class that implements it", () => {
    expect(
      reportedOver(`${CHANNEL}const channel: Channel = new Wire();\nchannel.send();\n`),
    ).toEqual(["DS1203 Channel.close [Wire]"]);
  });

  it("is not reported where the checker could not say which classes implement the interface", () => {
    expect(
      reportedOver(`${CHANNEL}const channel: Channel = new Wire();\nchannel.send();\n`, true),
    ).toEqual([]);
  });

  it("names its implementations in position order, one declared and one matched by shape", () => {
    expect(
      reportedOver(
        [
          CHANNEL,
          "class Declared implements Channel {",
          "  send(): void {",
          '    console.log("declared");',
          "  }",
          "  close(): void {",
          '    console.log("declared");',
          "  }",
          "}",
          "",
          "const channels: Channel[] = [new Wire(), new Declared()];",
          "for (const channel of channels) {",
          "  channel.send();",
          "}",
          "",
        ].join("\n"),
      ),
    ).toEqual(["DS1203 Channel.close [Wire, Declared]"]);
  });

  it("names no implementation in a package the run reads only through an import", () => {
    const options = { strict: true, module: "NodeNext", moduleResolution: "nodenext" };
    const root = writeProject({
      "package.json": '{ "name": "root", "private": true, "workspaces": ["packages/*"] }\n',
      "packages/a/package.json":
        '{ "name": "a", "private": true, "type": "module", "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } } }\n',
      "packages/a/tsconfig.json": JSON.stringify({
        compilerOptions: { ...options, outDir: "dist", rootDir: "src", declaration: true },
        include: ["src/**/*.ts"],
      }),
      "packages/a/src/index.ts": [
        "export class Wire {",
        "  send(): void {",
        '    console.log("send");',
        "  }",
        "  close(): void {",
        '    console.log("close");',
        "  }",
        "}",
        "",
      ].join("\n"),
      "packages/b/package.json":
        '{ "name": "b", "private": true, "type": "module", "bin": "./src/main.ts", "dependencies": { "a": "workspace:*" } }\n',
      "packages/b/tsconfig.json": JSON.stringify({
        compilerOptions: options,
        include: ["src/**/*.ts"],
      }),
      "packages/b/src/main.ts": [
        'import { Wire } from "a";',
        "",
        CHANNEL.replace("class Wire", "class Pipe"),
        "const channels: Channel[] = [new Wire(), new Pipe()];",
        "for (const channel of channels) {",
        "  channel.send();",
        "}",
        "",
      ].join("\n"),
    });
    try {
      mkdirSync(join(root, ".git"));
      mkdirSync(join(root, "packages/b/node_modules"));
      symlinkSync(join(root, "packages/a"), join(root, "packages/b/node_modules/a"));
      const { config } = resolve({
        repository: JSON.stringify({
          target: { kind: "application" },
          analysis: { configurations: [{ id: "b", project: "packages/b/tsconfig.json" }] },
        }),
        repositoryLabel: "deadset.json",
      });
      expect(lines(family(emitterInputOf(root, config)))).toEqual(["DS1203 Channel.close [Pipe]"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
