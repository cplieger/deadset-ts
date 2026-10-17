import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { nodeHost } from "../../bin/node-host.ts";
import { CONFIG_MAX_BYTES } from "../contract/config.generated.ts";
import { EDGES_FILE } from "../edges.ts";
import type { Host } from "../host.ts";
import { run, type Writer } from "../run.ts";
import { BASELINE_FILE, IGNORE_FILE } from "../suppress-file.ts";

/** A valid document of each kind the target holds at its root. */
const VALID: Readonly<Record<string, string>> = {
  [EDGES_FILE]: '{"edges": {}}',
  [IGNORE_FILE]: '{"ignore": []}',
  [BASELINE_FILE]: '{"baseline": []}',
  "deadset.json": '{"target": {"kind": "library"}}',
};

/** A directory holding a target root, `target`, and room beside it; removed afterwards. */
function tree(): { readonly top: string; readonly target: string } {
  const top = mkdtempSync(join(tmpdir(), "deadset-ts-documents-"));
  onTestFinished(() => {
    rmSync(top, { recursive: true, force: true });
  });
  const target = join(top, "target");
  const files: Readonly<Record<string, string>> = {
    "package.json":
      '{"name": "@example/documents", "version": "1.0.0", "type": "module", "exports": "./a.ts"}',
    "tsconfig.json": '{"compilerOptions": {"strict": true, "noEmit": true}, "include": ["*.ts"]}',
    "a.ts": "export const a = 1;\n",
  };
  mkdirSync(target);
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(target, name), text);
  }
  return { top, target };
}

class MemoryWriter implements Writer {
  text = "";
  write(text: string): void {
    this.text += text;
  }
}

/**
 * One analysis of `target`, run from `top` and configured centrally over the platform host
 * with `replaced` in it, every path it read and the byte limit each read asked for. The
 * working directory and the recording reader are the helper's own, so `replaced` cannot hold them.
 */
function analyze(
  top: string,
  target: string,
  replaced: Partial<Omit<Host, "workingDirectory" | "readFile">> = {},
): { code: number; err: string; read: string[]; limits: Map<string, number | undefined> } {
  const central = join(top, "central.json");
  writeFileSync(central, VALID["deadset.json"] ?? "");
  const read: string[] = [];
  const limits = new Map<string, number | undefined>();
  const host: Host = {
    ...nodeHost(),
    ...replaced,
    workingDirectory: () => top,
    readFile: (path, limit) => {
      read.push(path);
      limits.set(path, limit);
      return nodeHost().readFile(path, limit);
    },
  };
  const err = new MemoryWriter();
  const code = run(
    ["analyze", `--target=${target}`, `--central=${central}`, `--report=${join(top, "r.json")}`],
    new MemoryWriter(),
    err,
    host,
  );
  return { code, err: err.text, read, limits };
}

function setupLead(name: string): string {
  return `setup failure: unreadable-document: ${name}`;
}

/**
 * The exit code a document the run cannot read ends it with, and how the line naming it
 * starts: the repository configuration is a configuration document, refused with the usage code.
 */
const UNREADABLE: readonly (readonly [string, number, (target: string) => string])[] = [
  [EDGES_FILE, 3, () => setupLead(EDGES_FILE)],
  [IGNORE_FILE, 3, () => setupLead(IGNORE_FILE)],
  [BASELINE_FILE, 3, () => setupLead(BASELINE_FILE)],
  ["deadset.json", 2, (target) => `deadset-ts: ${join(target, "deadset.json")}`],
];

describe("a document at the target root", () => {
  it.each(UNREADABLE)("named %s that is a directory ends the run with %i", (name, code, lead) => {
    const { top, target } = tree();
    mkdirSync(join(target, name));

    const got = analyze(top, target);

    expect(got.code, got.err).toBe(code);
    expect(got.err).toContain(`${lead(target)}: is not a regular file`);
  });

  it.each([EDGES_FILE, IGNORE_FILE, BASELINE_FILE])(
    "named %s that cannot be read prints its setup failure with the fix, and only that line",
    (name) => {
      const { top, target } = tree();
      mkdirSync(join(target, name));

      const got = analyze(top, target);

      expect(got.err).toBe(
        `${setupLead(name)}: is not a regular file: make it a regular file inside the target root that the run can read, or remove it\n`,
      );
    },
  );

  it.each(UNREADABLE)(
    "named %s that links outside the target root ends the run with %i, nothing read from it",
    (name, code, lead) => {
      const { top, target } = tree();
      const outside = join(top, "outside.json");
      writeFileSync(outside, VALID[name] ?? "");
      symlinkSync(outside, join(target, name));

      const got = analyze(top, target);

      expect(got.code, got.err).toBe(code);
      expect(got.err).toContain(`${lead(target)}: resolves to ${outside}, outside the target root`);
      expect(got.read).not.toContain(outside);
      expect(got.read).not.toContain(join(target, name));
    },
  );

  it.each(UNREADABLE)("named %s that is a named pipe ends the run with %i", (name, code, lead) => {
    const { top, target } = tree();
    execFileSync("mkfifo", [join(target, name)]);

    const got = analyze(top, target);

    expect(got.code, got.err).toBe(code);
    expect(got.err).toContain(`${lead(target)}: is not a regular file`);
  });

  it.each(UNREADABLE)(
    "named %s that is a symbolic link loop ends the run with %i",
    (name, code, lead) => {
      const { top, target } = tree();
      symlinkSync(name, join(target, name));

      const got = analyze(top, target);

      expect(got.code, got.err).toBe(code);
      expect(got.err).toContain(`${lead(target)}: ELOOP`);
    },
  );

  it.each(UNREADABLE)(
    "named %s whose kind cannot be read ends the run with %i",
    (name, code, lead) => {
      const { top, target } = tree();
      const document = join(target, name);

      const got = analyze(top, target, {
        kindOf: (path) => {
          if (path === document) {
            throw new Error(`EIO: i/o error, stat '${path}'`);
          }
          return nodeHost().kindOf(path);
        },
      });

      expect(got.code, got.err).toBe(code);
      expect(got.err).toContain(`${lead(target)}: EIO: i/o error`);
    },
  );

  it.each(UNREADABLE.map(([name]) => name))(
    "named %s that links to a file inside the target root is read",
    (name) => {
      const { top, target } = tree();
      mkdirSync(join(target, "kept"));
      writeFileSync(join(target, "kept", name), VALID[name] ?? "");
      symlinkSync(join(target, "kept", name), join(target, name));

      const got = analyze(top, target);

      expect(got.code, got.err).toBe(0);
      expect(got.read).toContain(join(target, "kept", name));
    },
  );

  it.each([EDGES_FILE, IGNORE_FILE, BASELINE_FILE, "deadset.json"])(
    "named %s past the Contract's bound is refused with the usage code, read one byte past it",
    (name) => {
      const { top, target } = tree();
      writeFileSync(join(target, name), " ".repeat(CONFIG_MAX_BYTES + 1));

      const got = analyze(top, target);

      expect(got.code, got.err).toBe(2);
      expect(got.err).toContain(`${name}: holds more than ${String(CONFIG_MAX_BYTES)} bytes`);
      expect(got.limits.get(join(target, name))).toBe(CONFIG_MAX_BYTES + 1);
    },
  );
});
