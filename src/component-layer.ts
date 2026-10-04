/**
 * How a snapshot reads component files: a file-system layer that never reaches the disk gives
 * every configuration the snapshot opens a `contentMappers` member naming this analyzer's own
 * mapper, or none, in place of any the configuration declares, because a configuration's own
 * member wins over one it extends. The mapper resolves as a package linked into the
 * `node_modules` beside each configuration, to a directory holding only its manifest.
 */

import type { CreateSnapshotParams } from "@typescript/native/unstable/sync";
import type { Host } from "./host.ts";
import { dirnamePath, joinPath } from "./paths.ts";

/** The name the mapper's manifest declares and every configuration's entry names. */
export const MAPPER_PACKAGE = "deadset-ts-component-files";

/** The file system one snapshot is created with. */
export type SnapshotFileSystem = NonNullable<CreateSnapshotParams["fileSystem"]>;

/** The manifest of the mapper's package, which runs `command`. */
export function mapperManifest(command: readonly string[]): string {
  return `${JSON.stringify(
    {
      name: MAPPER_PACKAGE,
      version: "0.0.0",
      private: true,
      typescript: { contentMapper: { exec: command } },
    },
    null,
    2,
  )}\n`;
}

/** The offset past the white space and comments from `at`. */
function pastTrivia(text: string, from: number): number {
  let at = from;
  for (;;) {
    if (/\s/u.test(text[at] ?? "x")) {
      at += 1;
    } else if (text.startsWith("//", at)) {
      const end = text.slice(at).search(/[\n\r]/u);
      at = end < 0 ? text.length : at + end;
    } else if (text.startsWith("/*", at)) {
      const end = text.indexOf("*/", at + 2);
      at = end < 0 ? text.length : end + 2;
    } else {
      return at;
    }
  }
}

/** The offset past the string opening at `from`. */
function pastString(text: string, from: number): number {
  let at = from + 1;
  while (at < text.length && text[at] !== '"') {
    at += text[at] === "\\" ? 2 : 1;
  }
  return at + 1;
}

/** The offset past the value starting at `from`: a string, a bracketed value, or a bare word. */
function pastValue(text: string, from: number): number {
  const first = text[from];
  if (first === '"') {
    return pastString(text, from);
  }
  if (first !== "{" && first !== "[") {
    let at = from;
    while (at < text.length && /[^\s,}\]/]/u.test(text[at] ?? "")) {
      at += 1;
    }
    return at;
  }
  let depth = 0;
  let at = from;
  while (at < text.length) {
    at = pastTrivia(text, at);
    const char = text[at];
    if (char === '"') {
      at = pastString(text, at);
      continue;
    }
    if (char === "{" || char === "[") {
      depth += 1;
    } else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) {
        return at + 1;
      }
    }
    at += 1;
  }
  return at;
}

/**
 * One configuration's text with its top-level `contentMappers` member set to `mappers`,
 * the member's own value replaced where it has one and the member written first
 * otherwise. Every line keeps its number. Text that holds no object is returned as is,
 * for the compiler to refuse.
 */
export function withContentMappers(text: string, mappers: unknown): string {
  const value = JSON.stringify(mappers);
  const open = pastTrivia(text, 0);
  if (text[open] !== "{") {
    return text;
  }
  let at = pastTrivia(text, open + 1);
  const empty = text[at] === "}";
  while (at < text.length && text[at] === '"') {
    const keyEnd = pastString(text, at);
    const key = text.slice(at, keyEnd);
    const valueStart = pastTrivia(text, pastTrivia(text, keyEnd) + 1);
    const valueEnd = pastValue(text, valueStart);
    if (key === '"contentMappers"') {
      return text.slice(0, valueStart) + value + text.slice(valueEnd);
    }
    at = pastTrivia(text, valueEnd);
    if (text[at] !== ",") {
      break;
    }
    at = pastTrivia(text, at + 1);
  }
  return `${text.slice(0, open + 1)}"contentMappers":${value}${empty ? "" : ","}${text.slice(open + 1)}`;
}

/** This analyzer's mapper: the extensions it reads and the directory of its package. */
interface ComponentMapper {
  readonly extensions: readonly string[];
  readonly packageDirectory: string;
}

/**
 * The layer one snapshot is created with: every configuration named carrying `mapper`, its
 * package linked beside it, or no mapper at all where `mapper` is absent. A configuration
 * `written` holds is that text, which exists nowhere else; any other is read through the host.
 */
export function componentLayer(
  host: Host,
  configFiles: readonly string[],
  mapper: ComponentMapper | undefined,
  written: ReadonlyMap<string, string> = new Map(),
): SnapshotFileSystem {
  const mappers =
    mapper === undefined ? [] : [{ package: MAPPER_PACKAGE, extensions: [...mapper.extensions] }];
  const files: Record<string, string> = {};
  const symlinks: Record<string, { target: string; host: boolean }> = {};
  for (const configFile of configFiles) {
    files[configFile] = withContentMappers(
      written.get(configFile) ?? host.readFile(configFile),
      mappers,
    );
    if (mapper !== undefined) {
      symlinks[joinPath(dirnamePath(configFile), "node_modules", MAPPER_PACKAGE)] = {
        target: mapper.packageDirectory,
        host: true,
      };
    }
  }
  return { kind: "layer", files, symlinks };
}
