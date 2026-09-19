import { readdirSync, readFileSync, statSync } from "node:fs";
import type { DirectoryEntry, Host, PathKind } from "../src/host.ts";

/**
 * The filesystem of the platform the command runs on.
 *
 * It is the one module that names the platform: everything the analysis is made of
 * takes the filesystem as a parameter, so a consumer compiling the published
 * sources needs the compiler's types and nothing else.
 */
export function nodeHost(): Host {
  return {
    workingDirectory: () => process.cwd(),
    readFile: (path) => readFileSync(path, "utf8"),
    readDirectory: (path): readonly DirectoryEntry[] =>
      readdirSync(path, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        directory: entry.isDirectory(),
      })),
    kindOf: (path): PathKind => {
      const stat = statSync(path, { throwIfNoEntry: false });
      if (stat === undefined) {
        return "absent";
      }
      return stat.isDirectory() ? "directory" : "file";
    },
  };
}
