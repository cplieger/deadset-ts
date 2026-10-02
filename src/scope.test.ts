import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import {
  fixture,
  negativeDocument,
  negatives,
  scopeExamples,
} from "../__test-helpers__/fixtures.ts";
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
    {
      name: "a key written twice",
      text: '{"target":{"path":"a"},"target":{"path":"b"}}',
      detail: 'member "target" is written twice',
    },
    {
      name: "a key written twice inside a consumer",
      text: '{"target":{"path":"."},"consumers":[{"path":"a","path":"b"}]}',
      detail: "consumers[0].path",
    },
    {
      name: "a workspace that is null",
      text: '{"target":{"path":"."},"workspace":null}',
      detail: "scope: workspace is not a string",
    },
    {
      name: "a workspace naming nothing",
      text: '{"target":{"path":"."},"workspace":""}',
      detail: "scope: workspace names nothing",
    },
    {
      name: "a role that is null",
      text: '{"target":{"role":null,"path":"."}}',
      detail: "target.role is not a string",
    },
    {
      name: "a consumer list that is null",
      text: '{"target":{"path":"."},"consumers":null}',
      detail: "consumers is not an array",
    },
    {
      name: "a consumer that is null",
      text: '{"target":{"path":"."},"consumers":[null]}',
      detail: "consumers[0] is not an object",
    },
    {
      name: "a consumer naming an empty id",
      text: '{"target":{"path":"."},"consumers":[{"id":"","path":"c"}]}',
      detail: "consumers[0].id names nothing",
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

describe("the Contract's scope documents", () => {
  it("holds refused and accepted documents for this suite to run", () => {
    expect(negatives("contract/scope.schema.json").length).toBeGreaterThan(0);
    expect(scopeExamples().length).toBeGreaterThan(0);
  });

  it.each(
    negatives("contract/scope.schema.json").map((row) => ({
      file: row.file,
      // The value the index row's JSON Pointer names, spelled as a refusal names it.
      names: row.instance_path
        .split("/")
        .slice(1)
        .map((segment) => (/^[0-9]+$/u.test(segment) ? `[${segment}]` : `.${segment}`))
        .join("")
        .replace(/^\./u, ""),
    })),
  )("refuses $file, naming the value its index row names", ({ file, names }) => {
    const path = join(scratch(), "scope.json");
    writeFileSync(path, negativeDocument(file));

    expect(() => readScope(HOST, path)).toThrow(ScopeError);
    expect(() => readScope(HOST, path)).toThrow(names);
  });

  it.each(scopeExamples())("accepts $file", ({ text }) => {
    const path = join(scratch(), "scope.json");
    writeFileSync(path, text);
    const declared = JSON.parse(text) as { consumers?: unknown[] };

    expect(readScope(HOST, path).consumers).toHaveLength(declared.consumers?.length ?? 0);
  });

  it("reads every member of the document that declares them all", () => {
    const dir = scratch();
    const path = join(dir, "scope.json");
    writeFileSync(
      path,
      scopeExamples().find((entry) => entry.file === "target-and-consumers.json")?.text ?? "",
    );

    expect(readScope(HOST, path)).toEqual({
      target: { id: "example.com/app", path: join(dir, "app") },
      consumers: [
        { id: "example.com/consumer", path: join(dir, "consumer") },
        { id: "", path: "/src/example.com/tool" },
      ],
    });
  });
});
