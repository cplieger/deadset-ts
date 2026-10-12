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

  it("reads past a comment on a later line, and a block comment that opens with its own solidus", () => {
    expect(withContentMappers('{\n  "a": 1, // note\n  "contentMappers": []\n}', MAPPERS)).toBe(
      '{\n  "a": 1, // note\n  "contentMappers": [{"package":"m","extensions":[".vue"]}]\n}',
    );
    expect(withContentMappers('{ /*/ "contentMappers": 1 */ "include": [] }', MAPPERS)).toBe(
      '{"contentMappers":[{"package":"m","extensions":[".vue"]}], /*/ "contentMappers": 1 */ "include": [] }',
    );
  });

  it("reads a key whose string escapes a quote", () => {
    expect(withContentMappers('{ "say \\"hi\\"": 1, "contentMappers": 2 }', MAPPERS)).toBe(
      '{ "say \\"hi\\"": 1, "contentMappers": [{"package":"m","extensions":[".vue"]}] }',
    );
  });

  it("reads past a bare value, and replaces one the mappers member holds", () => {
    expect(
      withContentMappers('{ "strict": true, "contentMappers": null, "include": [] }', MAPPERS),
    ).toBe(
      '{ "strict": true, "contentMappers": [{"package":"m","extensions":[".vue"]}], "include": [] }',
    );
  });

  it("reads past a nested value whose strings hold brackets and comment openers", () => {
    const text = '{ "compilerOptions": { "paths": { "a/*": ["}"] } }, "contentMappers": [] }';
    expect(withContentMappers(text, MAPPERS)).toBe(
      '{ "compilerOptions": { "paths": { "a/*": ["}"] } }, "contentMappers": [{"package":"m","extensions":[".vue"]}] }',
    );
  });

  it("writes the mappers first where the text ends inside a comment or a string", () => {
    const written = '{"contentMappers":[{"package":"m","extensions":[".vue"]}],';
    expect(withContentMappers('{ "include": [] // trailing', MAPPERS)).toBe(
      `${written} "include": [] // trailing`,
    );
    expect(withContentMappers("{ /* open", MAPPERS)).toBe(`${written} /* open`);
    expect(withContentMappers('{"include', MAPPERS)).toBe(`${written}"include`);
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
