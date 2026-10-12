import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { fixture } from "../__test-helpers__/fixtures.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import { runSweep, type RunSweep } from "./analysis.ts";
import { resolve } from "./resolve.ts";
import { run, type Writer } from "./run.ts";
import { scopeForDir } from "./scope.ts";
import { openEngine } from "./session.ts";

const TARGET = fixture("projects", "injection-container");

/** The fixture swept for production, under its own configuration or the one given. */
function sweepFixture(document?: string): RunSweep {
  const path = join(TARGET, "deadset.json");
  const { config } = resolve({
    repository: document ?? readFileSync(path, "utf8"),
    repositoryLabel: path,
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

/** Each record of the class, with its declaration, site and detail. */
function injected(swept: RunSweep): string[] {
  return swept.retained
    .filter((held) => held.class === "injection-container")
    .map(
      (held) =>
        `${nameOf(swept, held.id)} ${held.site.path}:${String(held.site.line)}:${String(held.site.column)} ${held.detail}`,
    );
}

/** Each member of the services the sweep reports dead. */
function deadMembers(swept: RunSweep): string[] {
  return swept.sweep.candidates
    .map((candidate) => nameOf(swept, candidate.id))
    .filter((name) => /^(Mailer|Clock|Reporter|Plain)\./u.test(name));
}

/** The registrations the fixture's configuration names. */
const REGISTRATIONS = [
  { module: "@example/container", name: "Container.bind" },
  { module: "@example/container", name: "Module" },
] as const;

/**
 * The records of the class over one written project beside the fixture's container
 * package, swept with the decorator class off and the registrations given.
 */
function injectedIn(
  files: Readonly<Record<string, string>>,
  registrations: readonly { readonly module: string; readonly name: string }[] = REGISTRATIONS,
): string[] {
  const root = writeProject({
    "tsconfig.json": readFileSync(join(TARGET, "tsconfig.json"), "utf8"),
    "package.json": readFileSync(join(TARGET, "package.json"), "utf8"),
    "container/index.d.ts": readFileSync(join(TARGET, "container", "index.d.ts"), "utf8"),
    ...files,
  });
  try {
    const { config } = resolve({
      repository: JSON.stringify({
        target: { kind: "application" },
        exemptions: { disabled: ["decorator"] },
        ts: { injection_registrations: registrations },
      }),
      repositoryLabel: join(root, "deadset.json"),
    });
    const host = nodeHost();
    return injected(
      runSweep(openEngine({ collectTiming: false }), host, scopeForDir(host, root), config, {
        marked: [],
        mode: { production: true },
      }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** One module's text, a line per argument. */
function lines(...text: readonly string[]): string {
  return `${text.join("\n")}\n`;
}

class MemoryWriter implements Writer {
  text = "";
  write(text: string): void {
    this.text += text;
  }
}

describe("injection-container", () => {
  it("retains each decorated property of a class a container constructs, at what says it does", () => {
    expect(injected(sweepFixture())).toEqual([
      "Mailer.transport src/main.ts:6:22 registered by Container.bind",
      "Clock.zone src/main.ts:8:23 registered by Module",
      "Reporter.sink src/services.ts:21:3 injected by @inject",
    ]);
  });

  it("reports what no container injects once the decorator class is off", () => {
    const swept = sweepFixture(
      JSON.stringify({
        target: { kind: "application" },
        exemptions: { disabled: ["decorator"] },
        ts: {
          injection_registrations: [
            { module: "@example/container", name: "Container.bind" },
            { module: "@example/container", name: "Module" },
          ],
        },
      }),
    );

    expect(deadMembers(swept)).toEqual(["Mailer.helper", "Plain.value"]);
  });

  it("registers no class through a call where the configuration names no registration", () => {
    const swept = sweepFixture(
      JSON.stringify({
        target: { kind: "application" },
        exemptions: { disabled: ["decorator"] },
      }),
    );

    expect(injected(swept)).toEqual(["Reporter.sink src/services.ts:21:3 injected by @inject"]);
    expect(deadMembers(swept)).toEqual([
      "Mailer.transport",
      "Mailer.helper",
      "Clock.zone",
      "Plain.value",
    ]);
  });
});

describe("the members a container populates", () => {
  it("are the decorated properties and accessors of a registered class, not its plain properties or decorated methods", () => {
    expect(
      injectedIn({
        "src/main.ts": lines(
          'import { Container, inject } from "@example/container";',
          "function mark(..._args: readonly unknown[]): void {}",
          "export class Service {",
          '  @inject("a") a: unknown;',
          "  plain: unknown;",
          "  @mark get read(): unknown { return this.plain; }",
          "  @mark set write(value: unknown) { this.plain = value; }",
          "  @mark run(): void {}",
          "}",
          "new Container().bind(Service);",
        ),
      }),
    ).toEqual([
      "Service.a src/main.ts:10:22 registered by Container.bind",
      "Service.read src/main.ts:10:22 registered by Container.bind",
      "Service.write src/main.ts:10:22 registered by Container.bind",
    ]);
  });

  it("are read from a class only where one of its constructor's parameters carries a decorator, at any depth", () => {
    expect(
      injectedIn({
        "src/main.ts": lines(
          'import { inject } from "@example/container";',
          "export class Asks {",
          '  @inject("x") x: unknown;',
          '  constructor(@inject("f") f: string, g: number) { void [f, g]; }',
          "}",
          "export class Plain {",
          '  @inject("y") y: unknown;',
          "  constructor(f: string) { void f; }",
          "}",
          "export namespace Inner {",
          "  export class Nested {",
          '    @inject("z") z: unknown;',
          '    constructor(@inject("h") h: string) { void h; }',
          "  }",
          "}",
        ),
      }),
    ).toEqual([
      "Asks.x src/main.ts:3:3 injected by @inject",
      "Inner.Nested.z src/main.ts:12:5 injected by @inject",
    ]);
  });

  it("are read from a class a call registers where one entry names its callee and another names nothing", () => {
    expect(
      injectedIn(
        {
          "src/main.ts": lines(
            'import { Container, inject } from "@example/container";',
            "export class Service {",
            '  @inject("a") a: unknown;',
            "}",
            "new Container().bind(Service);",
          ),
        },
        [...REGISTRATIONS, { module: "@example/container", name: "Missing" }],
      ),
    ).toEqual(["Service.a src/main.ts:5:22 registered by Container.bind"]);
  });
});

describe("print-retained over a project whose classes a container constructs", () => {
  it("prints each injected property with the registration that holds it back, and exits 0", async () => {
    const out = new MemoryWriter();
    const err = new MemoryWriter();

    expect(run(["print-retained", `--target=${TARGET}`], out, err, nodeHost())).toBe(0);
    expect(err.text).toBe("");
    await expect(
      out.text,
      "regenerate with `npx vitest --run -u src/injection-container.test.ts` and review the diff",
    ).toMatchFileSnapshot(fixture("golden", "injection-container.retained.txt"));
  });
});
