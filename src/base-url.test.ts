import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import { baseUrlPaths } from "./base-url.ts";
import { run, type Writer } from "./run.ts";

const DISCARD: Writer = { write: () => undefined };

const LOAD_TIMEOUT = 60_000;

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("the paths a baseUrl gives", () => {
  it("are none where no baseUrl is set, so the options' own paths stand", () => {
    expect(baseUrlPaths({ paths: { "@a/*": ["./a/*"] } })).toBeUndefined();
  });

  it("read each target against the baseUrl and look up every other specifier below it", () => {
    expect(
      baseUrlPaths({ baseUrl: "/repo/src", paths: { "@a/*": ["lib/*", "../shared/*"] } } as never),
    ).toEqual({ "*": ["/repo/src/*"], "@a/*": ["/repo/src/lib/*", "/repo/shared/*"] });
  });

  it("keep a star pattern the configuration writes itself", () => {
    expect(baseUrlPaths({ baseUrl: "/repo", paths: { "*": ["types/*"] } } as never)).toEqual({
      "*": ["/repo/types/*"],
    });
  });
});

/** The report one `analyze` run over `files` writes. */
function analyzed(files: Readonly<Record<string, string>>): {
  code: number;
  findings: { code: string; symbol: { name: string } }[];
} {
  const root = writeProject(files);
  roots.push(root);
  const dir = mkdtempSync(join(tmpdir(), "deadset-ts-base-url-"));
  roots.push(dir);
  const report = join(dir, "report.json");
  const code = run(["analyze", "--target=.", `--report=${report}`], DISCARD, DISCARD, {
    ...nodeHost(),
    workingDirectory: () => root,
  });
  return { code, ...(JSON.parse(readFileSync(report, "utf8")) as { findings: [] }) };
}

describe("a configuration whose imports resolve through a baseUrl", () => {
  it(
    "resolves them as the compilers before version 7 do, through an inherited baseUrl too",
    () => {
      const options = {
        strict: true,
        module: "NodeNext",
        moduleResolution: "nodenext",
        noEmit: true,
        types: [],
      };
      const got = analyzed({
        "package.json": JSON.stringify({
          name: "@example/app",
          private: true,
          type: "module",
          main: "./app/main.ts",
        }),
        "deadset.json": JSON.stringify({ target: { kind: "application" } }),
        "tsconfig.json": JSON.stringify({
          compilerOptions: { ...options, baseUrl: "." },
          files: [],
          references: [{ path: "./app" }],
        }),
        "app/tsconfig.json": JSON.stringify({
          extends: "../tsconfig.json",
          compilerOptions: { composite: true, paths: { "@lib/*": ["./lib/*"] } },
          include: ["*.ts", "../lib/*.ts"],
        }),
        "app/main.ts": [
          'import { mapped } from "@lib/mapped.js";',
          'import { bare } from "lib/bare.js";',
          "console.log(mapped, bare);",
          "",
        ].join("\n"),
        "lib/mapped.ts": "export const mapped = 1;\nexport const spare = 2;\n",
        "lib/bare.ts": "export const bare = 3;\n",
      });

      expect(got.code).toBe(1);
      expect(got.findings.map((one) => `${one.code} ${one.symbol.name}`)).toEqual(["DS1001 spare"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "resolves them so in a workspace member, whose program the workspace builds",
    () => {
      const got = analyzed({
        "package.json": JSON.stringify({
          name: "@example/root",
          private: true,
          workspaces: ["packages/*"],
        }),
        "deadset.json": JSON.stringify({ target: { kind: "application" } }),
        "packages/app/package.json": JSON.stringify({
          name: "@example/app",
          private: true,
          type: "module",
          main: "./src/main.ts",
          dependencies: { "@example/lib": "workspace:*" },
        }),
        "packages/app/tsconfig.json": JSON.stringify({
          compilerOptions: {
            strict: true,
            module: "NodeNext",
            moduleResolution: "nodenext",
            noEmit: true,
            types: [],
            baseUrl: "src",
            paths: { "@app/*": ["*"] },
          },
          include: ["src"],
        }),
        "packages/app/src/main.ts": [
          'import { mapped } from "@app/mapped.js";',
          'import { shared } from "@example/lib";',
          "console.log(mapped, shared);",
          "",
        ].join("\n"),
        "packages/app/src/mapped.ts": "export const mapped = 1;\nexport const spare = 2;\n",
        "packages/lib/package.json": JSON.stringify({
          name: "@example/lib",
          private: true,
          type: "module",
          exports: "./src/index.ts",
        }),
        "packages/lib/tsconfig.json": JSON.stringify({
          compilerOptions: {
            strict: true,
            module: "NodeNext",
            moduleResolution: "nodenext",
            noEmit: true,
            types: [],
          },
          include: ["src"],
        }),
        "packages/lib/src/index.ts": "export const shared = 3;\n",
      });

      expect(got.findings.map((one) => `${one.code} ${one.symbol.name}`)).toEqual(["DS1001 spare"]);
      expect(got.code).toBe(1);
    },
    LOAD_TIMEOUT,
  );

  it(
    "resolves them so in a workspace member whose configuration extends the baseUrl and replaces paths",
    () => {
      const options = {
        strict: true,
        module: "NodeNext",
        moduleResolution: "nodenext",
        noEmit: true,
        types: [],
      };
      const got = analyzed({
        "package.json": JSON.stringify({
          name: "@example/root",
          private: true,
          workspaces: ["packages/*", "demos"],
        }),
        "deadset.json": JSON.stringify({ target: { kind: "application" } }),
        "tsconfig.json": JSON.stringify({
          compilerOptions: {
            ...options,
            baseUrl: ".",
            paths: { "@example/*": ["packages/*/src/index.ts"] },
          },
          files: [],
        }),
        "demos/package.json": JSON.stringify({
          name: "@example/demos",
          private: true,
          type: "module",
          main: "./src/main.ts",
          dependencies: { "@example/lib": "workspace:*" },
        }),
        "demos/tsconfig.json": JSON.stringify({
          extends: "../tsconfig.json",
          compilerOptions: { paths: { "@example/*": ["./packages/*/src/index.ts"] } },
          include: ["src"],
        }),
        "demos/src/main.ts": 'import { shared } from "@example/lib";\n\nconsole.log(shared);\n',
        "packages/lib/package.json": JSON.stringify({
          name: "@example/lib",
          private: true,
          type: "module",
          exports: "./dist/index.js",
        }),
        "packages/lib/tsconfig.json": JSON.stringify({
          compilerOptions: options,
          include: ["src"],
        }),
        "packages/lib/src/index.ts": "export const shared = 3;\nexport const spare = 4;\n",
      });

      expect(got.findings.map((one) => `${one.code} ${one.symbol.name}`)).toEqual(["DS1001 spare"]);
      expect(got.code).toBe(1);
    },
    LOAD_TIMEOUT,
  );
});
