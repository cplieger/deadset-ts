import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { fixture } from "../__test-helpers__/fixtures.ts";
import { readScope, scopeForDir, ScopeError } from "./scope.ts";

const HOST = nodeHost();

/**
 * A directory of this test's own, removed afterwards. It is outside the committed
 * fixtures because another test hashes those to pin that a run edits nothing, and
 * the two run at the same time.
 */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "deadset-ts-"));
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

describe("a scope document", () => {
  it("resolves a relative path against its own directory", () => {
    const dir = scratch();
    const file = join(dir, "scope.json");
    mkdirSync(join(dir, "target"));
    writeFileSync(
      file,
      `${JSON.stringify({ target: { role: "target", path: "./target" }, consumers: [] })}\n`,
    );

    expect(readScope(HOST, file).target.path).toBe(join(dir, "target"));
  });

  it.each([
    { name: "a document that is not JSON", text: "{", detail: "scope.json" },
    { name: "an undeclared key", text: '{"targets":{}}', detail: "targets is not a declared key" },
    { name: "no target", text: "{}", detail: "names no target" },
    {
      name: "a role its position contradicts",
      text: '{"target":{"role":"consumer","path":"."}}',
      detail: 'target.role is "consumer", want "target"',
    },
    {
      name: "a target naming no path",
      text: '{"target":{"role":"target"}}',
      detail: "target.path names nothing",
    },
    {
      name: "an undeclared key inside a module",
      text: '{"target":{"path":".","kind":"x"}}',
      detail: "target.kind is not a declared key",
    },
  ])("is refused for $name", ({ text, detail }) => {
    const file = join(scratch(), "scope.json");
    writeFileSync(file, text);

    expect(() => readScope(HOST, file)).toThrow(ScopeError);
    expect(() => readScope(HOST, file)).toThrow(detail);
  });

  it("is refused when the target is not a directory", () => {
    expect(() =>
      scopeForDir(HOST, fixture("projects", "two-projects", "core", "tsconfig.json")),
    ).toThrow("is not a directory");
  });

  it("is the target directory alone when no document is given", () => {
    const dir = scratch();

    expect(scopeForDir(HOST, dir)).toEqual({ target: { id: "", path: dir }, consumers: [] });
  });
});

describe("a target with no scope document", () => {
  it("is refused when nothing is at the path", () => {
    expect(() => scopeForDir(HOST, join(scratch(), "absent"))).toThrow("does not exist");
  });
});
