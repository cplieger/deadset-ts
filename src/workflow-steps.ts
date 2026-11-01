/**
 * The command strings beside a target root's packages: a CI workflow's `run:` steps, the git
 * hooks, the hook managers' commands and the makefile's recipe lines, each with the directory
 * it runs in. A workflow or hook manager file is read by `text/yaml.ts`, and one it does not
 * read gives no command; each command is read by `commands/read.ts`.
 */

import type { SourceFile } from "@typescript/native/ast";
import { pathsNamed, readCommands } from "./commands/read.ts";
import type { Host } from "./host.ts";
import { isRecord } from "./json-document.ts";
import { joinPath, resolvePath } from "./paths.ts";
import type { SourceFiles } from "./source-files.ts";
import { filesIn } from "./fs/tree.ts";
import { yamlDocument } from "./text/yaml.ts";

/** One file a workflow step, git hook or recipe runs or names. */
interface WorkflowEntry {
  readonly file: SourceFile;
  /** The word or the path that named it, as the command writes it. */
  readonly source: string;
}

/** One command string and the directory it runs in. */
interface CommandString {
  readonly text: string;
  /**
   * The directory it runs in, absolute, or `undefined` where the file does not state what runs
   * where: a directory holding a `${{ }}` expression, which GitHub Actions evaluates.
   */
  readonly dir: string | undefined;
  /** The directory the file writes for it, as YAML decodes it, which layer 3 holds beside the text. */
  readonly writtenDirectory: string | undefined;
}

const WORKFLOWS = ".github/workflows";

/** The directories whose every file is a git hook script, run as the shell runs it. */
const HOOK_DIRS = [".husky", ".githooks"] as const;

/** The key setting the directory a workflow step, or each step a `defaults.run` covers, runs in. */
const WORKING_DIRECTORY = "working-directory";

/**
 * The hook manager files, each with the key its commands are written under and the key of their
 * directory: lefthook's `root`, https://lefthook.dev/configuration/root/
 */
const HOOK_MANAGERS: readonly (readonly [string, string, string | undefined])[] = [
  [".pre-commit-config.yaml", "entry", undefined],
  ...["lefthook.yml", "lefthook.yaml", ".lefthook.yml"].map(
    (name) => [name, "run", "root"] as const,
  ),
];

/** The names GNU make reads a makefile under, in the order it tries them. */
const MAKEFILES = ["GNUmakefile", "makefile", "Makefile"] as const;

function readText(host: Host, path: string): string | undefined {
  try {
    return host.readFile(path);
  } catch {
    return undefined;
  }
}

/** The text a YAML scalar's value stands for, or `undefined` for a collection or a null. */
function scalarText(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : undefined;
}

/** The `defaults.run.working-directory` one mapping writes, as YAML decodes it. */
function defaultDirectory(mapping: Record<string, unknown>): string | undefined {
  const defaults = mapping["defaults"];
  const run = isRecord(defaults) ? defaults["run"] : undefined;
  return isRecord(run) ? scalarText(run[WORKING_DIRECTORY]) : undefined;
}

/**
 * Every command one workflow or hook manager file writes under `key`, in every mapping of the
 * document, each with the directory it runs in: its mapping's `dirKey` value, else, in a workflow
 * file, the innermost `defaults.run.working-directory` of a mapping holding it, else `root`. A
 * file `yamlDocument` does not read gives none.
 */
function keyedCommands(
  text: string,
  root: string,
  key: string,
  dirKey: string | undefined,
): readonly CommandString[] {
  const found: CommandString[] = [];
  const visit = (node: unknown, inherited: string | undefined): void => {
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item, inherited);
      }
      return;
    }
    if (!isRecord(node)) {
      return;
    }
    const here = (dirKey === WORKING_DIRECTORY ? defaultDirectory(node) : undefined) ?? inherited;
    const command = scalarText(node[key]);
    if (command !== undefined && command.trim() !== "") {
      const written = (dirKey === undefined ? undefined : scalarText(node[dirKey])) ?? here;
      found.push({
        text: command,
        dir:
          written === undefined
            ? root
            : written.includes("${{")
              ? undefined
              : resolvePath(root, written),
        writtenDirectory: written,
      });
    }
    for (const value of Object.values(node)) {
      visit(value, here);
    }
  };
  visit(yamlDocument(text), undefined);
  return found;
}

/** The path of each git hook script at `root`, every file in {@link HOOK_DIRS}. */
function hookScripts(host: Host, root: string): readonly string[] {
  return HOOK_DIRS.flatMap((dir) =>
    filesIn(host, joinPath(root, dir), () => true).map((name) => joinPath(root, dir, name)),
  );
}

/** The makefile make reads at `root`, the first of {@link MAKEFILES} there. */
function makefileAt(host: Host, root: string): string | undefined {
  return MAKEFILES.map((name) => joinPath(root, name)).find(
    (candidate) => host.kindOf(candidate) === "file",
  );
}

/**
 * Each recipe line of the target root's makefile: a line that starts with a tab, joined with
 * the lines a trailing `\` continues it onto, less the `@`, `-` and `+` make reads before it.
 * Make runs each line in a shell of its own.
 */
function recipeLines(host: Host, root: string): readonly CommandString[] {
  const path = makefileAt(host, root);
  const text = path === undefined ? undefined : readText(host, path);
  return (text ?? "")
    .replace(/\\\r?\n/gu, " ")
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("\t"))
    .map((line) => ({
      text: line.slice(1).replace(/^[@+-]+/u, ""),
      dir: root,
      writtenDirectory: undefined,
    }));
}

/**
 * Every command the target root's workflow steps, git hooks, hook managers and makefile run:
 * the `run:` steps of the workflow files in `.github/workflows`, each file in `.husky` and
 * `.githooks` as one shell script, the `entry:` commands of `.pre-commit-config.yaml`, the
 * `run:` commands of a lefthook file and the makefile's recipe lines.
 */
export function workflowCommands(host: Host, targetRoot: string): readonly CommandString[] {
  const root = resolvePath(host.workingDirectory(), targetRoot);
  const workflows = filesIn(host, joinPath(root, WORKFLOWS), (name) => /\.ya?ml$/u.test(name));
  return [
    ...workflows.flatMap((name) =>
      keyedCommands(
        readText(host, joinPath(root, WORKFLOWS, name)) ?? "",
        root,
        "run",
        WORKING_DIRECTORY,
      ),
    ),
    ...hookScripts(host, root).map((path): CommandString => ({
      text: readText(host, path) ?? "",
      dir: root,
      writtenDirectory: undefined,
    })),
    ...HOOK_MANAGERS.flatMap(([name, key, dirKey]) =>
      keyedCommands(readText(host, joinPath(root, name)) ?? "", root, key, dirKey),
    ),
    ...recipeLines(host, root),
  ];
}

/**
 * The whole text of each file {@link workflowCommands} reads a command from, each workflow file,
 * git hook, hook manager file and makefile at the target root. Layer 3 holds it whole, so a part
 * no command is read from, a comment included, or one the reading of the structure misses, still
 * holds every file it names.
 */
export function commandFileTexts(host: Host, targetRoot: string): readonly string[] {
  const root = resolvePath(host.workingDirectory(), targetRoot);
  return [
    ...filesIn(host, joinPath(root, WORKFLOWS), (name) => /\.ya?ml$/u.test(name)).map((name) =>
      joinPath(root, WORKFLOWS, name),
    ),
    ...hookScripts(host, root),
    ...HOOK_MANAGERS.map(([name]) => joinPath(root, name)),
    ...[makefileAt(host, root) ?? []].flat(),
  ].flatMap((path) => readText(host, path) ?? []);
}

/**
 * The own files the target root's workflow steps, git hooks and recipes run or name, as
 * `pathsNamed` reads each command.
 */
export function workflowEntries(
  host: Host,
  targetRoot: string,
  files: SourceFiles,
): readonly WorkflowEntry[] {
  const found: WorkflowEntry[] = [];
  for (const { text, dir } of workflowCommands(host, targetRoot)) {
    for (const { path, written } of pathsNamed(readCommands(text, dir))) {
      for (const file of files.named(path)) {
        found.push({ file, source: written });
      }
    }
  }
  return found;
}
