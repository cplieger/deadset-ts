import { describe, expect, it } from "vitest";
import type { Host } from "../host.ts";
import { readDocument, readJSONFile, readManifestAt } from "./manifest.ts";

/** A filesystem holding only `files`, whose read of `refused` throws. */
function hostOf(files: Readonly<Record<string, string>>, refused = ""): Host {
  const unread = (): never => {
    throw new Error("not read by a manifest reader");
  };
  return {
    workingDirectory: () => "/",
    readFile: (path) => {
      const text = files[path];
      if (path === refused || text === undefined) {
        throw new Error(`EACCES: ${path}`);
      }
      return text;
    },
    readDirectory: unread,
    kindOf: (path) => (Object.hasOwn(files, path) ? "file" : "absent"),
    realPath: unread,
    analyzerVersion: unread,
    writeDocument: unread,
    temporaryDirectory: unread,
    componentMapperCommand: unread,
  };
}

describe("one JSON file's read", () => {
  const host = hostOf(
    {
      "/a/package.json": '{ "name": "a" }',
      "/b/package.json": "{",
      "/c/package.json": "null",
      "/d/package.json": "{}",
    },
    "/d/package.json",
  );

  it("tells a parsed document, text that does not parse and a file that cannot be read apart", () => {
    expect(readJSONFile(host, "/a/package.json")).toEqual({
      kind: "read",
      text: '{ "name": "a" }',
      value: { name: "a" },
    });
    expect(readJSONFile(host, "/c/package.json")).toEqual({
      kind: "read",
      text: "null",
      value: null,
    });
    expect(readJSONFile(host, "/b/package.json")).toEqual({ kind: "malformed" });
    expect(readJSONFile(host, "/d/package.json")).toEqual({
      kind: "unread",
      reason: "EACCES: /d/package.json",
    });
  });

  it("is the one read the document and the manifest readers make", () => {
    expect(readDocument(host, "/c/package.json")).toEqual({ text: "null", value: null });
    expect(readDocument(host, "/b/package.json")).toBeUndefined();
    expect(readManifestAt(host, "/a")).toEqual({ kind: "read", manifest: { name: "a" } });
    expect(readManifestAt(host, "/c")).toEqual({ kind: "malformed" });
    expect(readManifestAt(host, "/d")).toEqual({
      kind: "unread",
      reason: "EACCES: /d/package.json",
    });
    expect(readManifestAt(host, "/e")).toEqual({ kind: "absent" });
  });
});
