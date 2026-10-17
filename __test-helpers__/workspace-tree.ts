import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { nodeHost } from "../bin/node-host.ts";
import { findWorkspace, type ParsedLayout } from "../src/load/workspace.ts";
import {
  workspaceResolver,
  type DefaultResolution,
  type MemberResolution,
  type WorkspaceResolver,
} from "../src/load/workspace-resolution.ts";

const written: string[] = [];

/** Removes every tree `workspaceAt` wrote; a file's `afterEach` calls it. */
export function removeWorkspaces(): void {
  for (const root of written.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The conditions an ECMAScript import under `nodenext` reads, with no custom one. */
const IMPORT = new Set(["types", "import", "node", "default"]);

/** What one configuration parses to, every path below the root. */
export interface TreeLayout {
  readonly files: readonly string[];
  readonly outDir?: string;
  readonly rootDir?: string;
}

/**
 * A workspace below a fresh directory: `files` maps paths to text (or is built from the
 * root, for text that spells it), `links` maps link paths to the directory each names,
 * and `layouts` maps a configuration path to what parsing it answers, every path below
 * the root.
 */
export function workspaceAt(
  files: Readonly<Record<string, string>> | ((root: string) => Readonly<Record<string, string>>),
  links: Readonly<Record<string, string>> = {},
  layouts: Readonly<Record<string, TreeLayout>> = {},
): {
  readonly root: string;
  readonly resolver: WorkspaceResolver;
  readonly resolve: (
    specifier: string,
    from: string,
    answered?: DefaultResolution,
    conditions?: ReadonlySet<string>,
  ) => MemberResolution;
} {
  const root = mkdtempSync(join(tmpdir(), "deadset-ts-resolution-"));
  written.push(root);
  mkdirSync(join(root, ".git"));
  const texts = typeof files === "function" ? files(root) : files;
  for (const [path, text] of Object.entries(texts)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  for (const [path, target] of Object.entries(links)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    symlinkSync(join(root, target), join(root, path));
  }
  const parse = (configFile: string): ParsedLayout | undefined => {
    const layout = layouts[configFile.slice(root.length + 1)];
    return layout === undefined
      ? undefined
      : {
          fileNames: layout.files.map((file) => join(root, file)),
          outDir: layout.outDir === undefined ? undefined : join(root, layout.outDir),
          rootDir: layout.rootDir === undefined ? undefined : join(root, layout.rootDir),
        };
  };
  const workspace = findWorkspace(nodeHost(), root, parse);
  if (workspace === undefined) {
    throw new Error("the written tree declares no workspace");
  }
  const resolver = workspaceResolver(nodeHost(), workspace);
  return {
    root,
    resolver,
    resolve: (specifier, from, answered, conditions = IMPORT) =>
      resolver.resolve(specifier, join(root, from), conditions, answered),
  };
}

/** A resolution to one file below the root. */
export function source(root: string, path: string, member: string): MemberResolution {
  return { kind: "source", file: join(root, path), member };
}
