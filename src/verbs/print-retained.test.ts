import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it, onTestFinished } from "vitest";
import { nodeHost } from "../../bin/node-host.ts";
import { writeProject } from "../../__test-helpers__/projects.ts";
import { run, type Writer } from "../run.ts";

const LOAD_TIMEOUT = 60_000;

class MemoryWriter implements Writer {
  text = "";
  write(text: string): void {
    this.text += text;
  }
}

const DECORATED = {
  "deadset.json":
    '{ "target": { "kind": "application" }, "ts": { "entry_files": ["src/main.ts"] } }\n',
  "package.json": '{ "name": "@example/retained", "private": true, "type": "module" }\n',
  "tsconfig.json":
    '{ "compilerOptions": { "strict": true, "target": "ESNext", "module": "NodeNext", "noEmit": true, "allowImportingTsExtensions": true }, "include": ["src/*.ts"] }\n',
  "src/register.ts":
    "export function register<T>(value: T, _context: ClassMethodDecoratorContext): T {\n  return value;\n}\n",
  "src/handlers.ts":
    'import { register } from "./register.ts";\n\nexport class Handlers {\n  @register\n  onStart(): void {}\n\n  @register\n  onStop(): void {}\n}\n',
  "src/main.ts": 'import { Handlers } from "./handlers.ts";\n\nnew Handlers().onStop();\n',
  "src/handlers.test.ts":
    'import { Handlers } from "./handlers.ts";\n\nnew Handlers().onStart();\n',
};

function printRetained(files: Readonly<Record<string, string>>): {
  code: number;
  out: string;
  err: string;
} {
  const root = writeProject(files);
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const out = new MemoryWriter();
  const err = new MemoryWriter();
  const code = run(["print-retained", `--target=${root}`], out, err, {
    ...nodeHost(),
    workingDirectory: () => tmpdir(),
  });
  return { code, out: out.text, err: err.text };
}

describe("print-retained", () => {
  it(
    "lists a declaration an exemption held back that only a test file uses, as the production sweep judges it",
    () => {
      expect(printRetained(DECORATED)).toEqual({
        code: 0,
        out: "ts://@example/retained/src/handlers.ts#Handlers.onStart\tsrc/handlers.ts:5:3\tdecorator\tsrc/handlers.ts:4:3\tdecorated by @register\n",
        err: "",
      });
    },
    LOAD_TIMEOUT,
  );

  it(
    "names on the error stream a derived configuration it dropped",
    () => {
      const got = printRetained({
        ...DECORATED,
        "tools/tsconfig.json": '{ "include": ["none/*.ts"] }\n',
      });

      expect(got.code).toBe(0);
      expect(got.err).toBe(
        "deadset-ts: the derived configuration tools/tsconfig.json was not built and is not analyzed: TS18003: No inputs were found in config file 'tools/tsconfig.json'. Specified 'include' paths were '[\"none/*.ts\"]' and 'exclude' paths were '[]'.\n",
      );
    },
    LOAD_TIMEOUT,
  );
});
