import { rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import { ConfigError } from "./config.ts";
import { resolve } from "./resolve.ts";
import { readTemplates } from "./template-field.ts";

function tree(files: Readonly<Record<string, string>>): string {
  const root = writeProject(files);
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function templatesOf(targetRoot: string, dirs: readonly string[]) {
  const { config } = resolve({
    repository: JSON.stringify({
      target: { kind: "application" },
      analysis: { template_dirs: dirs },
    }),
    repositoryLabel: "deadset.json",
  });
  return readTemplates(nodeHost(), targetRoot, config.analysis);
}

describe("the templates of a run", () => {
  it("are every file below each configured directory, each once, in path order", () => {
    const root = tree({
      "views/x.html": "x",
      "templates/b.html": "b",
      "templates/a/z.html": "a/z",
      "templates/a/b.html": "a/b",
      "templates/a.html": "a",
      "templates/A.html": "A",
    });

    expect(templatesOf(root, ["views", "templates/a", "templates"]).files).toEqual([
      { path: "templates/A.html", text: "A" },
      { path: "templates/a.html", text: "a" },
      { path: "templates/a/b.html", text: "a/b" },
      { path: "templates/a/z.html", text: "a/z" },
      { path: "templates/b.html", text: "b" },
      { path: "views/x.html", text: "x" },
    ]);
  });

  it("do not follow a symbolic link to a directory", () => {
    const root = tree({ "templates/page.html": "page", "elsewhere/inner.html": "inner" });
    symlinkSync(join(root, "elsewhere"), join(root, "templates", "linked"));

    expect(templatesOf(root, ["templates"]).files).toEqual([
      { path: "templates/page.html", text: "page" },
    ]);
  });

  it.each([
    ["an absolute path", "/templates"],
    ["the directory above the target root", ".."],
    ["a directory beside the target root", "../beside"],
    ["a file", "templates/page.html"],
    ["a directory the target does not hold", "absent"],
  ])("refuse %s as a usage error", (_, dir) => {
    const root = tree({
      "app/templates/page.html": "page",
      "beside/page.html": "page",
    });

    expect(() => templatesOf(join(root, "app"), [dir])).toThrow(
      new ConfigError(
        "malformed",
        "analysis.template_dirs",
        `analysis.template_dirs: ${JSON.stringify(dir)} is not a directory below the target root`,
      ),
    );
  });
});
