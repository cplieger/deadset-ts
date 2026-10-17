import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { targetConfigFiles, writeProject } from "../__test-helpers__/projects.ts";
import { discoverProjects } from "./load/discover.ts";
import { inventory } from "./inventory.ts";
import { memberNames } from "./member-names.ts";
import { scopeForDir } from "./scope.ts";
import { openEngine, runSession } from "./session.ts";

/** The members of one written project by written name, each as its display name. */
function indexOf(files: Readonly<Record<string, string>>): Record<string, string[]> {
  const root = writeProject(files);
  try {
    const host = nodeHost();
    const engine = openEngine({ collectTiming: false });
    const configFiles = targetConfigFiles(discoverProjects(engine, host, scopeForDir(host, root)));
    const { projects } = runSession(engine, configFiles, (project) => {
      const held = inventory(project, host, root);
      return memberNames(project.ownSourceFiles(), held);
    });
    const [index] = projects;
    if (index === undefined) {
      throw new Error("the project opened no configuration");
    }
    return Object.fromEntries(
      [...index].map(([name, members]) => [name, members.map((member) => member.name)]),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("the members of a project by written name", () => {
  it("index an identifier, a private name without its #, a string key and a numeric key", () => {
    expect(
      indexOf({
        "a.ts": [
          "export class Server {",
          "  #token = 1;",
          '  "x-y"(): number { return this.#token; }',
          "  7 = 2;",
          '  ["computed"] = 3;',
          "  get size(): number { return 0; }",
          "  set size(value: number) { void value; }",
          "}",
          "",
        ].join("\n"),
      }),
    ).toEqual({
      token: ["Server.#token"],
      "x-y": ["Server.'x-y'"],
      "7": ["Server.'7'"],
      size: ["Server.size"],
    });
  });

  it("list every member a name is written with, in inventory order", () => {
    expect(
      indexOf({
        "a.ts": [
          "export class First { run(): void {} }",
          "export interface Second { run(): void; }",
          "export enum Third { run }",
          "",
        ].join("\n"),
      }),
    ).toEqual({ run: ["First.run", "Second.run", "Third.run"] });
  });
});
