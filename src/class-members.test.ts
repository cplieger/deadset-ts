import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import { classMembers, type ClassSide } from "./class-members.ts";
import { discoverProjects } from "./discover.ts";
import { inventory } from "./inventory.ts";
import { scopeForDir } from "./scope.ts";
import { openEngine, runSession } from "./session.ts";

/** One module's text, a line per argument. */
function lines(...text: readonly string[]): string {
  return `${text.join("\n")}\n`;
}

/**
 * The members one side of the classes `named` carries, read over one written project, as
 * `class: member member …` in the order the answer gives them.
 */
function membersOf(
  files: Readonly<Record<string, string>>,
  named: readonly string[],
  side: ClassSide,
): string[] {
  const root = writeProject(files);
  try {
    const host = nodeHost();
    const engine = openEngine({ collectTiming: false });
    const configFiles = discoverProjects(engine, host, scopeForDir(host, root)).configFiles;
    const { projects } = runSession(engine, configFiles, (project) => {
      const held = inventory(project, host, root);
      const byId = new Map(held.symbols.map((symbol) => [symbol.id, symbol.name]));
      const ids = new Set(
        held.symbols
          .filter((symbol) => symbol.kind === "class" && named.includes(symbol.name))
          .map((symbol) => symbol.id),
      );
      return [...classMembers(project, held, ids, side)].map(
        ([id, members]) =>
          `${byId.get(id) ?? id}:${members.map((member) => ` ${byId.get(member.id) ?? member.id}`).join("")}`,
      );
    });
    const [only] = projects;
    if (only === undefined) {
      throw new Error("no project opened");
    }
    return only;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const CLASSES = {
  "node_modules/lib/package.json": '{ "name": "lib", "types": "./index.d.ts" }\n',
  "node_modules/lib/index.d.ts": "export declare class Remote { remote(): void; }\n",
  "main.ts": lines(
    'import { Remote } from "lib";',
    "export class Base {",
    "  shared = 1;",
    "  static make(): void {}",
    "  run(): void {}",
    "}",
    "export class Derived extends Base {",
    "  static build(): void {}",
    "  override run(): void {}",
    "}",
    "export class Local extends Remote {",
    "  own = 2;",
    "}",
    "export namespace Space {",
    "  export class Inner {",
    "    static count = 0;",
    "    value = 3;",
    "  }",
    "}",
  ),
};

describe("the members of a class's instances", () => {
  it("are its own and those it inherits from the target, an override the subclass's own, for the classes asked of at any depth", () => {
    expect(membersOf(CLASSES, ["Derived", "Local", "Space.Inner"], "instance")).toEqual([
      "Derived: Derived.run Base.shared",
      "Local: Local.own",
      "Space.Inner: Space.Inner.value",
    ]);
  });
});

describe("the members of a class itself", () => {
  it("are its static members and those it inherits, without the prototype, for each class asked of", () => {
    expect(membersOf(CLASSES, ["Base", "Derived", "Space.Inner"], "static")).toEqual([
      "Base: Base.make",
      "Derived: Derived.build Base.make",
      "Space.Inner: Space.Inner.count",
    ]);
  });
});
