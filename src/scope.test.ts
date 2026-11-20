import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import type { Host } from "./host.ts";
import {
  fixture,
  negativeDocument,
  negatives,
  scopeExamples,
} from "../__test-helpers__/fixtures.ts";
import { FailureExit } from "./failure.ts";
import { readScope, scopeForDir } from "./scope.ts";
import { UsageError } from "./usage.ts";

const HOST = nodeHost();

/** The Contract's bound on an input document, x-max-bytes of config.schema.json. */
const DOCUMENT_BOUND = 16 << 20;

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
    {
      name: "a target that is not an object",
      text: '{"target":"app"}',
      detail: "scope.json: target: the value is string, want object",
    },
    {
      name: "an undeclared key",
      text: '{"targets":{}}',
      detail: 'targets: the member "targets" is not one the schema declares',
    },
    { name: "no target", text: "{}", detail: 'target: the member "target" is absent' },
    {
      name: "a role its position contradicts",
      text: '{"target":{"role":"consumer","path":"."}}',
      detail: 'target.role: "consumer" is not one of "target"',
    },
    {
      name: "a target naming no path",
      text: '{"target":{"role":"target"}}',
      detail: 'target.path: the member "path" is absent',
    },
    {
      name: "an undeclared key inside a module",
      text: '{"target":{"path":".","kind":"x"}}',
      detail: 'target.kind: the member "kind" is not one the schema declares',
    },
    {
      name: "a key written twice",
      text: '{"target":{"path":"a"},"target":{"path":"b"}}',
      detail: 'target: line 1, column 24: the member "target" is written twice',
    },
    {
      name: "a key written twice inside a consumer",
      text: '{"target":{"path":"."},"consumers":[{"path":"a","path":"b"}]}',
      detail: "consumers[0].path: line 1, column 49:",
    },
    {
      name: "a workspace that is null",
      text: '{"target":{"path":"."},"workspace":null}',
      detail: "workspace: the value is null, want string",
    },
    {
      name: "a workspace naming nothing",
      text: '{"target":{"path":"."},"workspace":""}',
      detail: 'workspace: "" is shorter than 1 characters',
    },
    {
      name: "a role that is null",
      text: '{"target":{"role":null,"path":"."}}',
      detail: "target.role: the value is null, want string",
    },
    {
      name: "a consumer list that is null",
      text: '{"target":{"path":"."},"consumers":null}',
      detail: "consumers: the value is null, want array",
    },
    {
      name: "a consumer that is null",
      text: '{"target":{"path":"."},"consumers":[null]}',
      detail: "consumers[0]: the value is null, want object",
    },
    {
      name: "a consumer naming an empty id",
      text: '{"target":{"path":"."},"consumers":[{"id":"","path":"c"}]}',
      detail: 'consumers[0].id: "" is shorter than 1 characters',
    },
  ])("is refused for $name", ({ text, detail }) => {
    const file = join(scratch(), "scope.json");
    writeFileSync(file, text);

    expect(() => readScope(HOST, file)).toThrow(UsageError);
    expect(() => readScope(HOST, file)).toThrow(detail);
  });

  it("is refused when it is not JSON, naming the file and where the fault is", () => {
    const file = join(scratch(), "scope.json");
    writeFileSync(file, "{");

    expect(() => readScope(HOST, file)).toThrow(
      new UsageError(`scope: ${file}: line 1, column 2: a member name is expected`),
    );
  });

  it("is a usage error when the file it names cannot be read", () => {
    const file = join(scratch(), "absent-scope.json");
    let thrown: unknown;
    try {
      readScope(HOST, file);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UsageError);
    expect(thrown instanceof Error ? thrown.message : "").toContain(`scope: ${file}:`);
  });

  it("is read at the Contract's document bound and refused one byte past it", () => {
    const dir = scratch();
    const file = join(dir, "scope.json");
    const text = '{"target":{"path":"."}}';
    writeFileSync(file, text.padEnd(DOCUMENT_BOUND));

    expect(readScope(HOST, file).target.path).toBe(dir);

    writeFileSync(file, text.padEnd(DOCUMENT_BOUND + 1));

    expect(() => readScope(HOST, file)).toThrow(
      new UsageError(`scope: ${file}: holds more than ${String(DOCUMENT_BOUND)} bytes`),
    );
  });

  it("is read no further than one byte past the bound", () => {
    const dir = scratch();
    const file = join(dir, "scope.json");
    writeFileSync(file, '{"target":{"path":"."}}');
    const limits: (number | undefined)[] = [];
    const host: Host = {
      ...HOST,
      readFile: (path, limit) => {
        limits.push(limit);
        return HOST.readFile(path, limit);
      },
    };

    readScope(host, file);

    expect(limits).toEqual([DOCUMENT_BOUND + 1]);
  });

  it("is bounded in bytes, so one of two mebi three-byte characters, under the bound, is read", () => {
    const dir = scratch();
    const file = join(dir, "scope.json");
    const id = "\u{20AC}".repeat(2 << 20);
    writeFileSync(file, JSON.stringify({ target: { id, path: "." } }));

    expect(readScope(HOST, file).target.id).toBe(id);
  });

  it("is read at the bound when one string of nearly 16 Mi characters fills it", () => {
    const dir = scratch();
    const file = join(dir, "scope.json");
    const shape = (id: string): string => JSON.stringify({ target: { id, path: "." } });
    const id = "x".repeat(DOCUMENT_BOUND - shape("").length);
    writeFileSync(file, shape(id));

    expect(readScope(HOST, file).target.id).toBe(id);
  });

  it.each(
    ["é", "😀", "\u{FFFD}"].flatMap((char) =>
      Array.from({ length: Buffer.byteLength(char) }, (_, shift) => [char, shift] as const),
    ),
  )(
    "is refused past the bound written in %s after %i spaces, wherever in a character the read stops",
    (char, shift) => {
      const dir = scratch();
      const file = join(dir, "scope.json");
      const head = `{"target":{"path":"."}}${" ".repeat(shift)}`;
      const width = Buffer.byteLength(char);
      writeFileSync(
        file,
        head + char.repeat(Math.ceil((DOCUMENT_BOUND - head.length) / width) + 1),
      );

      expect(() => readScope(HOST, file)).toThrow(
        new UsageError(`scope: ${file}: holds more than ${String(DOCUMENT_BOUND)} bytes`),
      );
    },
  );

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
    const absent = join(scratch(), "absent");

    expect(() => scopeForDir(HOST, absent)).toThrow(FailureExit);
    expect(() => scopeForDir(HOST, absent)).toThrow(
      `setup failure: no-program: the target ${absent} does not exist, so it holds no compiler configuration, no file named tsconfig*.json, jsconfig*.json: name the directory that holds one`,
    );
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

    expect(() => readScope(HOST, path)).toThrow(UsageError);
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
