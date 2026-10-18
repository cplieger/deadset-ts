/**
 * The source files a CI workflow's `run:` steps and the repository's git hooks name by their
 * path from the target root. A workflow or hook file is read as text, line by line, with no
 * YAML parsed.
 */

import type { SourceFile } from "@typescript/native/ast";
import type { Host } from "./host.ts";
import { joinPath, relativePath, resolvePath } from "./paths.ts";
import type { SourceFiles } from "./source-files.ts";
import { filesIn } from "./fs/tree.ts";
import { commandsOf, scriptTokens, unquoted, withoutComment } from "./text/shell.ts";

/** One file a workflow step names. */
interface WorkflowEntry {
  readonly file: SourceFile;
  /** The token that named it, as the command writes it. */
  readonly source: string;
}

const WORKFLOWS = ".github/workflows";

/** A line holding a run command: indentation and one sequence marker before `run:`. */
const RUN_LINE = /^(\s*(?:- )?)run:(.*)$/u;

/** The directories whose every file is a git hook script, run as the shell runs it. */
const HOOK_DIRS = [".husky", ".githooks"] as const;

/** A line setting the directory a workflow step, or each step a `defaults.run` covers, runs in. */
const WORKING_DIRECTORY = /^(\s*(?:- )?)working-directory:(.*)$/u;

const LEFTHOOK_FILES = ["lefthook.yml", "lefthook.yaml", ".lefthook.yml"] as const;

/** A line setting the directory a lefthook command runs in. */
const LEFTHOOK_ROOT = /^(\s*(?:- )?)root:(.*)$/u;

/** The hook manager files whose commands are written under a key, with that key. */
const HOOK_MANAGERS: readonly (readonly [string, RegExp])[] = [
  [".pre-commit-config.yaml", /^(\s*(?:- )?)entry:(.*)$/u],
  ...LEFTHOOK_FILES.map((name) => [name, RUN_LINE] as const),
];

/** The names GNU make reads a makefile under, in the order it tries them. */
const MAKEFILES = ["GNUmakefile", "makefile", "Makefile"] as const;

const BLOCK_SCALAR = /^[|>][+-]?$/u;

/** A token holding one of these is computed or a pattern, so it names no file. */
const COMPUTED = /[${*?[]/u;

const INDENT = /^\s*/u;

/** The files directly in one directory whose name `accepts`, by path in name order. */
function pathsIn(host: Host, dir: string, accepts: (name: string) => boolean): readonly string[] {
  return filesIn(host, dir, accepts).map((name) => joinPath(dir, name));
}

function readText(host: Host, path: string): string | undefined {
  try {
    return host.readFile(path);
  } catch {
    return undefined;
  }
}

/** Every line one workflow file's `run:` steps hold, or every line of the values written under `key`. */
export function runCommands(text: string, key: RegExp = RUN_LINE): readonly string[] {
  const lines = text.split(/\r?\n/u);
  const found: string[] = [];
  for (let at = 0; at < lines.length; at += 1) {
    const match = key.exec(lines[at] ?? "");
    if (match === null) {
      continue;
    }
    const column = (match[1] ?? "").length;
    const value = unquoted((match[2] ?? "").trim());
    if (!BLOCK_SCALAR.test(value)) {
      found.push(value);
      continue;
    }
    for (let next = at + 1; next < lines.length; next += 1) {
      const line = lines[next] ?? "";
      if (line.trim() !== "" && (INDENT.exec(line)?.[0].length ?? 0) <= column) {
        break;
      }
      found.push(line);
    }
  }
  return found;
}

/**
 * The commands of the recipe lines of the target root's makefile, each line's in order: a
 * recipe line is one that starts with a tab, joined with the lines a trailing `\`
 * continues it onto.
 */
function recipeLines(host: Host, root: string): readonly (readonly string[])[] {
  const path = MAKEFILES.map((name) => joinPath(root, name)).find(
    (candidate) => host.kindOf(candidate) === "file",
  );
  const text = path === undefined ? undefined : readText(host, path);
  if (text === undefined) {
    return [];
  }
  return text
    .replace(/\\\r?\n/gu, " ")
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("\t"))
    .map((line) => commandsOf(withoutComment(line.slice(1).replace(/^[@+-]+/u, ""))));
}

/**
 * Every token the recipe lines of the target root's makefile hold, each with the directory
 * below the root it is read against: make runs each line in a shell of its own, so a `cd`
 * moves the directory of the later commands of its line alone.
 */
function recipeTokens(host: Host, root: string): readonly { token: string; dir: string }[] {
  const found: { token: string; dir: string }[] = [];
  for (const line of recipeLines(host, root)) {
    let dir = root;
    for (const command of line) {
      const tokens = scriptTokens(command);
      const [first, target, ...rest] = tokens;
      if (first === "cd" && target !== undefined && rest.length === 0 && !COMPUTED.test(target)) {
        dir = resolvePath(dir, target);
        continue;
      }
      for (const token of tokens) {
        found.push({ token, dir: relativePath(root, dir) ?? "" });
      }
    }
  }
  return found;
}

/**
 * Every command the target root's workflow steps, git hooks and makefile run: the `run:`
 * steps of the workflow files in `.github/workflows`, every line of each file in `.husky`
 * and `.githooks`, the `entry:` commands of `.pre-commit-config.yaml`, the `run:` commands
 * of a lefthook file and the makefile's recipe lines.
 */
export function workflowCommands(host: Host, targetRoot: string): readonly string[] {
  const root = resolvePath(host.workingDirectory(), targetRoot);
  return [...stepCommands(host, root), ...recipeLines(host, root).flat()];
}

/**
 * Every directory the target root's workflow steps and lefthook commands are set to run in, as
 * written: each `working-directory` of a workflow file and each `root` of a lefthook file.
 */
export function commandDirectories(host: Host, targetRoot: string): readonly string[] {
  const root = resolvePath(host.workingDirectory(), targetRoot);
  return [
    ...workflowFiles(host, root).flatMap((path) =>
      runCommands(readText(host, path) ?? "", WORKING_DIRECTORY),
    ),
    ...LEFTHOOK_FILES.flatMap((name) =>
      runCommands(readText(host, joinPath(root, name)) ?? "", LEFTHOOK_ROOT),
    ),
  ];
}

/** The workflow files in `.github/workflows` at one root, by path in name order. */
function workflowFiles(host: Host, root: string): readonly string[] {
  return pathsIn(host, joinPath(root, WORKFLOWS), (name) => /\.ya?ml$/u.test(name));
}

/** Every token the commands {@link workflowCommands} reads hold. */
export function workflowTokens(host: Host, targetRoot: string): readonly string[] {
  const root = resolvePath(host.workingDirectory(), targetRoot);
  return [
    ...stepCommands(host, root).flatMap((command) => scriptTokens(command)),
    ...recipeTokens(host, root).map(({ token }) => token),
  ];
}

/** The commands of the workflow steps, git hooks and hook managers at one root. */
function stepCommands(host: Host, root: string): readonly string[] {
  const commands: string[] = [];
  for (const path of workflowFiles(host, root)) {
    commands.push(...runCommands(readText(host, path) ?? ""));
  }
  for (const dir of HOOK_DIRS) {
    for (const path of pathsIn(host, joinPath(root, dir), () => true)) {
      commands.push(...(readText(host, path) ?? "").split(/\r?\n/u).map(withoutComment));
    }
  }
  for (const [name, key] of HOOK_MANAGERS) {
    commands.push(...runCommands(readText(host, joinPath(root, name)) ?? "", key));
  }
  return commands;
}

/**
 * The own files the target root's workflow steps and git hooks name, as
 * {@link workflowTokens} reads them: a token equal to a file's path below the target root,
 * with or without a leading `./`, whatever directory the step runs in.
 */
export function workflowEntries(
  host: Host,
  targetRoot: string,
  files: SourceFiles,
): readonly WorkflowEntry[] {
  const found: WorkflowEntry[] = [];
  for (const token of workflowTokens(host, targetRoot)) {
    if (COMPUTED.test(token)) {
      continue;
    }
    const file = files.byPath.get(token.startsWith("./") ? token.slice(2) : token);
    if (file !== undefined) {
      found.push({ file, source: token });
    }
  }
  const root = resolvePath(host.workingDirectory(), targetRoot);
  for (const { token, dir } of recipeTokens(host, root)) {
    const below =
      COMPUTED.test(token) || dir === ""
        ? undefined
        : relativePath(root, resolvePath(joinPath(root, dir), token));
    const file = below === undefined ? undefined : files.byPath.get(below);
    if (file !== undefined) {
      found.push({ file, source: token });
    }
  }
  return found;
}
