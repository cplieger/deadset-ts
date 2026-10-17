import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { nodeHost } from "../../bin/node-host.ts";
import { dependencySpecifiers, installedPackage, manifestsAbove } from "./module-lookup.ts";

const HOST = nodeHost();

/** A tree written below a fresh directory, removed after the case; a `null` entry is a directory. */
function tree(files: Readonly<Record<string, string | null>>): string {
  const root = mkdtempSync(join(tmpdir(), "deadset-ts-module-lookup-"));
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  for (const [path, text] of Object.entries(files)) {
    if (text === null) {
      mkdirSync(join(root, path), { recursive: true });
    } else {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
  }
  return root;
}

describe("the installed package an importer reads", () => {
  it("is the one hoisted to an ancestor's node_modules", () => {
    const root = tree({ "node_modules/pkg": null, "packages/a/src": null });

    expect(installedPackage(HOST, join(root, "packages", "a", "src"), "pkg")).toBe(
      join(root, "node_modules", "pkg"),
    );
  });

  it("is the nearest one, which shadows a hoisted one", () => {
    const root = tree({ "node_modules/pkg": null, "packages/a/node_modules/pkg": null });

    expect(installedPackage(HOST, join(root, "packages", "a"), "pkg")).toBe(
      join(root, "packages", "a", "node_modules", "pkg"),
    );
  });

  it("is a link a package manager wrote, named by the link's own path", () => {
    const root = tree({ "packages/b": null, "packages/a/node_modules": null });
    symlinkSync(join(root, "packages", "b"), join(root, "packages", "a", "node_modules", "b"));

    expect(installedPackage(HOST, join(root, "packages", "a"), "b")).toBe(
      join(root, "packages", "a", "node_modules", "b"),
    );
  });

  it("is no file of that name, which the compiler does not read as a package", () => {
    const root = tree({
      "node_modules/pkg": null,
      "packages/a/node_modules/pkg": "not a package\n",
    });

    expect(installedPackage(HOST, join(root, "packages", "a"), "pkg")).toBe(
      join(root, "node_modules", "pkg"),
    );
  });

  it("is absent where no ancestor installs it", () => {
    const root = tree({ "packages/a": null, "node_modules/other": null });

    expect(installedPackage(HOST, join(root, "packages", "a"), "pkg")).toBeUndefined();
  });
});

describe("the manifests above a directory", () => {
  const root = (): string =>
    tree({
      "package.json": '{ "name": "root" }\n',
      "packages/a/package.json": '{ "name": "a" }\n',
      "packages/a/src/deep": null,
      "outside/package.json": '{ "name": "outside" }\n',
      "outside/inner": null,
    });

  it("are read nearest first, up to the bound", () => {
    const at = root();

    expect(
      [...manifestsAbove(HOST, join(at, "packages", "a", "src", "deep"), at)].map(
        ({ dir, manifest }) => [dir, manifest["name"]],
      ),
    ).toEqual([
      [join(at, "packages", "a"), "a"],
      [at, "root"],
    ]);
  });

  it("stop at the bound, reading nothing above it", () => {
    const at = root();

    expect(
      [...manifestsAbove(HOST, join(at, "packages", "a", "src"), join(at, "packages"))].map(
        ({ dir }) => dir,
      ),
    ).toEqual([join(at, "packages", "a")]);
  });

  it("are the directory's own alone for a directory outside the bound", () => {
    const at = root();

    expect(
      [...manifestsAbove(HOST, join(at, "outside"), join(at, "packages"))].map(({ dir }) => dir),
    ).toEqual([join(at, "outside")]);
    expect([...manifestsAbove(HOST, join(at, "outside", "inner"), join(at, "packages"))]).toEqual(
      [],
    );
  });
});

describe("the specifiers a manifest declares a dependency with", () => {
  it("are one per dependency section naming it, in section order", () => {
    expect(
      dependencySpecifiers(
        {
          peerDependencies: { pkg: "^1" },
          dependencies: { pkg: "workspace:*", other: "1" },
          devDependencies: { other: "2" },
        },
        "pkg",
      ),
    ).toEqual(["workspace:*", "^1"]);
  });

  it("are none for a name only an inherited member spells", () => {
    expect(dependencySpecifiers({ dependencies: {} }, "constructor")).toEqual([]);
  });
});
