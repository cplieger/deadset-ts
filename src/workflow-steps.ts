/**
 * The source files a CI workflow's `run:` steps name by their path from the target root.
 * A workflow file is read as text, line by line, with no YAML parsed.
 */

import type { SourceFile } from "@typescript/native/unstable/ast";
import type { Host } from "./host.ts";
import { scriptTokens } from "./manifest.ts";
import { joinPath, resolvePath } from "./paths.ts";
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

const BLOCK_SCALAR = /^[|>][+-]?$/u;

const QUOTED = /^(["'])(.*)\1$/su;

/** A token holding one of these is computed or a pattern, so it names no file. */
const COMPUTED = /[${*?[]/u;

const INDENT = /^\s*/u;

function workflowFiles(host: Host, dir: string): readonly string[] {
  let entries;
  try {
    entries = host.readDirectory(dir);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => !entry.directory && /\.ya?ml$/u.test(entry.name))
    .map((entry) => joinPath(dir, entry.name))
    .sort();
}

/** Every command line one workflow file's `run:` steps hold. */
export function runCommands(text: string): readonly string[] {
  const lines = text.split(/\r?\n/u);
  const found: string[] = [];
  for (let at = 0; at < lines.length; at += 1) {
    const match = RUN_LINE.exec(lines[at] ?? "");
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

/** Every token the `run:` steps of the workflow files in the target root's `.github/workflows` hold. */
export function workflowTokens(host: Host, targetRoot: string): readonly string[] {
  const dir = joinPath(resolvePath(host.workingDirectory(), targetRoot), WORKFLOWS);
  const found: string[] = [];
  for (const path of workflowFiles(host, dir)) {
    let text: string;
    try {
      text = host.readFile(path);
    } catch {
      continue;
    }
    for (const command of runCommands(text)) {
      found.push(...scriptTokens(command));
    }
  }
  return found;
}

/**
 * The own files the `run:` steps of every workflow file in the target root's
 * `.github/workflows` name: a token equal to a file's path below the target root, with or
 * without a leading `./`, whatever directory the step runs in.
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
  return found;
}
