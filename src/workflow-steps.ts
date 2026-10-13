/**
 * The source files a CI workflow's `run:` steps and the repository's git hooks name by their
 * path from the target root. A workflow or hook file is read as text, line by line, with no
 * YAML parsed.
 */

import type { SourceFile } from "@typescript/native/ast";
import type { Host } from "./host.ts";
import { scriptTokens } from "./manifest.ts";
import { joinPath, relativePath, resolvePath } from "./paths.ts";
import type { SourceFiles } from "./source-files.ts";

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

/** The hook manager files whose commands are written under a key, with that key. */
const HOOK_MANAGERS: readonly (readonly [string, RegExp])[] = [
  [".pre-commit-config.yaml", /^(\s*(?:- )?)entry:(.*)$/u],
  ["lefthook.yml", RUN_LINE],
  ["lefthook.yaml", RUN_LINE],
  [".lefthook.yml", RUN_LINE],
];

/** The names GNU make reads a makefile under, in the order it tries them. */
const MAKEFILES = ["GNUmakefile", "makefile", "Makefile"] as const;

/** The operators that end one shell command of a recipe line. */
const COMMAND_SEPARATORS = /&&|\|\||;|\|/u;

const BLOCK_SCALAR = /^[|>][+-]?$/u;

const QUOTED = /^(["'])(.*)\1$/su;

/** A token holding one of these is computed or a pattern, so it names no file. */
const COMPUTED = /[${*?[]/u;

const INDENT = /^\s*/u;

/** The files directly in one directory whose name `accepts`, in name order. */
function filesIn(host: Host, dir: string, accepts: (name: string) => boolean): readonly string[] {
  let entries;
  try {
    entries = host.readDirectory(dir);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => !entry.directory && accepts(entry.name))
    .map((entry) => joinPath(dir, entry.name))
    .sort();
}

function readText(host: Host, path: string): string | undefined {
  try {
    return host.readFile(path);
  } catch {
    return undefined;
  }
}

/** Every command line one workflow file's `run:` steps, or the steps under `key`, hold. */
export function runCommands(text: string, key: RegExp = RUN_LINE): readonly string[] {
  const lines = text.split(/\r?\n/u);
  const found: string[] = [];
  for (let at = 0; at < lines.length; at += 1) {
    const match = key.exec(lines[at] ?? "");
    if (match === null) {
      continue;
    }
    const column = (match[1] ?? "").length;
    const value = (match[2] ?? "").trim().replace(QUOTED, "$2");
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
 * Every token the recipe lines of the target root's makefile hold, each with the directory
 * below the root it is read against: a recipe line is one that starts with a tab, joined
 * with the lines a trailing `\` continues it onto, and make runs each in a shell of its
 * own, so a `cd` moves the directory of the later commands of its line alone.
 */
function recipeTokens(host: Host, root: string): readonly { token: string; dir: string }[] {
  const path = MAKEFILES.map((name) => joinPath(root, name)).find(
    (candidate) => host.kindOf(candidate) === "file",
  );
  const text = path === undefined ? undefined : readText(host, path);
  if (text === undefined) {
    return [];
  }
  const found: { token: string; dir: string }[] = [];
  for (const line of text.replace(/\\\r?\n/gu, " ").split(/\r?\n/u)) {
    if (!line.startsWith("\t")) {
      continue;
    }
    let dir = root;
    for (const command of withoutComment(line.slice(1).replace(/^[@+-]+/u, "")).split(
      COMMAND_SEPARATORS,
    )) {
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

/** One shell line up to its comment: a `#` that starts a word outside quotes. */
function withoutComment(line: string): string {
  let quote = "";
  for (let at = 0; at < line.length; at += 1) {
    const char = line[at];
    if (quote !== "") {
      if (char === quote) {
        quote = "";
      } else if (char === "\\" && quote === '"') {
        at += 1;
      }
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === "\\") {
      at += 1;
    } else if (char === "#" && (at === 0 || /\s/u.test(line[at - 1] ?? ""))) {
      return line.slice(0, at);
    }
  }
  return line;
}

/**
 * Every token the target root's workflow steps, git hooks and makefile hold: the `run:`
 * steps of the workflow files in `.github/workflows`, every line of each file in `.husky`
 * and `.githooks`, the `entry:` commands of `.pre-commit-config.yaml`, the `run:` commands
 * of a lefthook file and the makefile's recipe lines.
 */
export function workflowTokens(host: Host, targetRoot: string): readonly string[] {
  const root = resolvePath(host.workingDirectory(), targetRoot);
  const commands: string[] = [];
  for (const path of filesIn(host, joinPath(root, WORKFLOWS), (name) => /\.ya?ml$/u.test(name))) {
    commands.push(...runCommands(readText(host, path) ?? ""));
  }
  for (const dir of HOOK_DIRS) {
    for (const path of filesIn(host, joinPath(root, dir), () => true)) {
      commands.push(...(readText(host, path) ?? "").split(/\r?\n/u).map(withoutComment));
    }
  }
  for (const [name, key] of HOOK_MANAGERS) {
    commands.push(...runCommands(readText(host, joinPath(root, name)) ?? "", key));
  }
  return [
    ...commands.flatMap((command) => scriptTokens(command)),
    ...recipeTokens(host, root).map(({ token }) => token),
  ];
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
