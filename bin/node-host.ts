import { randomBytes } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DirectoryEntry, Host, PathKind, TemporaryDirectory } from "../src/host.ts";

/** The name the manifest of this package declares. */
const PACKAGE_NAME = "@cplieger/deadset-ts";

/** The version the walk found, read once per process. */
let found: string | undefined;

/**
 * One manifest, or undefined where nothing readable is at that path: a file that
 * cannot be read or parsed is not one that declares this package, so the walk
 * passes it and the failure is the search's.
 */
function manifestAt(path: string): { name?: unknown; version?: unknown } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  return typeof parsed === "object" && parsed !== null ? parsed : undefined;
}

/**
 * The version of the package this file is part of, from the nearest manifest at
 * or above it that declares this package: a checkout resolves this file to the
 * manifest beside it, the emitted tree resolves the emitted copy to the same
 * file two directories up, and neither depth is written down. A manifest
 * declaring something else is not this package's, so the walk continues past it
 * rather than reporting the version of whatever the command was installed into.
 */
function readVersion(): string {
  const from = dirname(fileURLToPath(import.meta.url));
  let at = from;
  for (;;) {
    const manifest = manifestAt(join(at, "package.json"));
    if (manifest?.name === PACKAGE_NAME && typeof manifest.version === "string") {
      return manifest.version;
    }
    const up = dirname(at);
    if (up === at) {
      throw new Error(
        `no package.json declaring ${PACKAGE_NAME} with a version, from ${from} up to ${at}`,
      );
    }
    at = up;
  }
}

/** The mode every document the command writes carries. */
const DOCUMENT_MODE = 0o644;

/**
 * Writes one document through a temporary file in the same directory, piece by piece,
 * flushed and then renamed into place, so a run that dies partway leaves no truncated
 * document at the path.
 */
function writeAtomically(path: string, pieces: Iterable<string>): void {
  const temporary = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}`);
  const fd = openSync(temporary, "wx", DOCUMENT_MODE);
  try {
    try {
      fchmodSync(fd, DOCUMENT_MODE);
      for (const piece of pieces) {
        const bytes = Buffer.from(piece, "utf8");
        for (let written = 0; written < bytes.length;) {
          written += writeSync(fd, bytes, written);
        }
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
  } catch (error: unknown) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** A new directory under the platform's temporary directory. */
function temporaryDirectory(): TemporaryDirectory {
  const path = mkdtempSync(join(tmpdir(), "deadset-ts-mapper-"));
  return {
    path,
    remove: () => {
      rmSync(path, { recursive: true, force: true });
    },
  };
}

/**
 * The mapper beside this file, in the same form: the emitted tree runs the emitted
 * mapper and a checkout runs the source through the runtime's own type stripping.
 */
function componentMapperCommand(): readonly string[] {
  const here = fileURLToPath(import.meta.url);
  return [process.execPath, join(dirname(here), `component-mapper${extname(here)}`)];
}

/**
 * The filesystem of the platform the command runs on, and the version of the
 * package it was installed from.
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
    realPath: (path) => realpathSync(path),
    analyzerVersion: (): string => {
      found ??= readVersion();
      return found;
    },
    writeDocument: writeAtomically,
    temporaryDirectory,
    componentMapperCommand,
  };
}
