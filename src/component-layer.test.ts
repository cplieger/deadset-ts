import { describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { componentLayer, mapperManifest, withContentMappers } from "./component-layer.ts";
import type { Host } from "./host.ts";

const MAPPERS = [{ package: "m", extensions: [".vue"] }];

describe("the component layer", () => {
  it("writes the mappers first, on the first line, where the configuration has none", () => {
    expect(withContentMappers('{\n  "include": ["src"]\n}\n', MAPPERS)).toBe(
      '{"contentMappers":[{"package":"m","extensions":[".vue"]}],\n  "include": ["src"]\n}\n',
    );
    expect(withContentMappers("// a comment\n{}", MAPPERS)).toBe(
      '// a comment\n{"contentMappers":[{"package":"m","extensions":[".vue"]}]}',
    );
  });

  it("replaces the mappers a configuration declares, comments and nesting skipped", () => {
    const text = [
      "{",
      '  /* "contentMappers": "in a comment" */',
      '  "compilerOptions": { "contentMappers": [] },',
      '  "contentMappers": [{ "package": "theirs", "extensions": [".svelte"] }], // own',
      '  "include": ["src"],',
      "}",
    ].join("\n");
    expect(withContentMappers(text, MAPPERS)).toBe(
      [
        "{",
        '  /* "contentMappers": "in a comment" */',
        '  "compilerOptions": { "contentMappers": [] },',
        '  "contentMappers": [{"package":"m","extensions":[".vue"]}], // own',
        '  "include": ["src"],',
        "}",
      ].join("\n"),
    );
  });

  it("leaves a configuration that holds no object for the compiler to refuse", () => {
    expect(withContentMappers("[]", MAPPERS)).toBe("[]");
  });

  it("gives every configuration named the mappers and links the mapper's package beside it", () => {
    const host: Host = { ...nodeHost(), readFile: (path) => `{"files":[${JSON.stringify(path)}]}` };
    expect(
      componentLayer(host, ["/r/tsconfig.json", "/r/a/tsconfig.json"], {
        extensions: [".vue"],
        packageDirectory: "/tmp/m",
      }),
    ).toEqual({
      kind: "layer",
      files: {
        "/r/tsconfig.json":
          '{"contentMappers":[{"package":"deadset-ts-component-files","extensions":[".vue"]}],"files":["/r/tsconfig.json"]}',
        "/r/a/tsconfig.json":
          '{"contentMappers":[{"package":"deadset-ts-component-files","extensions":[".vue"]}],"files":["/r/a/tsconfig.json"]}',
      },
      symlinks: {
        "/r/node_modules/deadset-ts-component-files": { target: "/tmp/m", host: true },
        "/r/a/node_modules/deadset-ts-component-files": { target: "/tmp/m", host: true },
      },
    });
  });

  it("gives every configuration named no mapper, and links nothing, where no mapper is given", () => {
    const host: Host = {
      ...nodeHost(),
      readFile: () => '{"contentMappers":[{"package":"theirs"}]}',
    };
    expect(componentLayer(host, ["/r/tsconfig.json"], undefined)).toEqual({
      kind: "layer",
      files: { "/r/tsconfig.json": '{"contentMappers":[]}' },
      symlinks: {},
    });
  });

  it("declares the mapper's command in the manifest the compiler reads", () => {
    expect(JSON.parse(mapperManifest(["/bin/node", "/p/mapper.js"]))).toEqual({
      name: "deadset-ts-component-files",
      version: "0.0.0",
      private: true,
      typescript: { contentMapper: { exec: ["/bin/node", "/p/mapper.js"] } },
    });
  });
});
