/**
 * The command strings beside a target root's packages: a CI workflow's `run:` steps, the git
 * hooks, the hook managers' commands and scripts and the makefile's recipe lines, each with the
 * directory it runs in. A workflow or hook manager file is read by `text/yaml.ts`, and one it does not
 * read gives no command; each command is read by `commands/read.ts`.
 */

import type { SourceFile } from "@typescript/native/ast";
import type { HeldText } from "../commands/held.ts";
import { pathsNamed, readCommands, type CommandReading } from "../commands/read.ts";
import { PART } from "../commands/shell.ts";
import type { Host } from "../host.ts";
import { isRecord } from "../json-document.ts";
import { joinPath, resolvePath } from "../paths.ts";
import type { SourceFiles } from "../source-files.ts";
import { filesIn } from "../fs/tree.ts";
import { yamlDocument } from "../text/yaml.ts";

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
}

const WORKFLOWS = ".github/workflows";

/** The directories whose every file is a git hook script, run as the shell runs it. */
const HOOK_DIRS = [".husky", ".githooks"] as const;

/** The key setting the directory a workflow step, or each step a `defaults.run` covers, runs in. */
const WORKING_DIRECTORY = "working-directory";

/** One hook manager's file. */
interface HookManager {
  readonly name: string;
  /** The key its commands are written under. */
  readonly key: string;
  /** The key of a command's directory: lefthook's `root`, https://lefthook.dev/configuration/root/ */
  readonly dirKey?: string;
  /** Whether its hooks name script files it runs, as lefthook's do. */
  readonly scripts?: true;
}

const HOOK_MANAGERS: readonly HookManager[] = [
  { name: ".pre-commit-config.yaml", key: "entry" },
  ...["lefthook.yml", "lefthook.yaml", ".lefthook.yml"].map((name): HookManager => ({
    name,
    key: "run",
    dirKey: "root",
    scripts: true,
  })),
];

/**
 * The directories lefthook searches for a hook's scripts after the file's `source_dir` and
 * `source_dir_local`: https://github.com/evilmartians/lefthook/blob/master/internal/command/run.go
 */
const LEFTHOOK_DIRS = [".config/lefthook", ".config/lefthook-local"] as const;

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
      });
    }
    for (const value of Object.values(node)) {
      visit(value, here);
    }
  };
  visit(yamlDocument(text), undefined);
  return found;
}

/**
 * The command lefthook runs for each script a lefthook file's hooks name, each key of a hook's
 * `scripts` and each `script` of a job in its `jobs`, a group's among them, from each directory
 * it searches: its `runner`, then the path `<dir>/<hook>/<name>` quoted as lefthook quotes it,
 * run in the target root: https://lefthook.dev/configuration/Scripts/
 */
function lefthookScripts(text: string, root: string): readonly CommandString[] {
  const document = yamlDocument(text);
  if (!isRecord(document)) {
    return [];
  }
  const dirs = [
    scalarText(document["source_dir"]) ?? ".lefthook/",
    scalarText(document["source_dir_local"]) ?? ".lefthook-local/",
    ...LEFTHOOK_DIRS,
  ];
  const found: CommandString[] = [];
  const add = (hook: string, name: string, runner: string | undefined): void => {
    for (const dir of dirs) {
      const path = `'${joinPath(dir, hook, name).replaceAll("'", "'\\''")}'`;
      found.push({
        text: runner === undefined || runner.trim() === "" ? path : `${runner} ${path}`,
        dir: root,
      });
    }
  };
  const jobs = (hook: string, list: unknown): void => {
    for (const job of Array.isArray(list) ? list : []) {
      const script = isRecord(job) ? scalarText(job["script"]) : undefined;
      if (isRecord(job) && script !== undefined) {
        add(hook, script, scalarText(job["runner"]));
      }
      const group = isRecord(job) ? job["group"] : undefined;
      jobs(hook, isRecord(group) ? group["jobs"] : undefined);
    }
  };
  for (const [hook, value] of Object.entries(document)) {
    const scripts = isRecord(value) ? value["scripts"] : undefined;
    for (const [name, options] of Object.entries(isRecord(scripts) ? scripts : {})) {
      add(hook, name, isRecord(options) ? scalarText(options["runner"]) : undefined);
    }
    jobs(hook, isRecord(value) ? value["jobs"] : undefined);
  }
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
 * One recipe line as make hands it to the shell: each `$$` a `$`, and each reference to a
 * variable or a function, which make expands first, a part only the run knows:
 * https://www.gnu.org/software/make/manual/html_node/Reference.html
 */
function expandedByMake(line: string): string {
  let expanded = "";
  for (let at = 0; at < line.length; at += 1) {
    const char = line.charAt(at);
    const next = line.charAt(at + 1);
    if (char !== "$") {
      expanded += char;
    } else if (next === "$") {
      expanded += "$";
      at += 1;
    } else {
      let end = at + 1;
      if (next === "(" || next === "{") {
        const close = next === "(" ? ")" : "}";
        for (let depth = 0; end < line.length; end += 1) {
          depth += line.charAt(end) === next ? 1 : line.charAt(end) === close ? -1 : 0;
          if (depth === 0) {
            break;
          }
        }
      }
      expanded += PART;
      at = Math.min(end, line.length);
    }
  }
  return expanded;
}

/**
 * Each recipe line of the target root's makefile: a line that starts with a tab, joined with
 * the lines a trailing `\` continues it onto, less the `@`, `-` and `+` make reads before it,
 * as make expands it. Make runs each line in a shell of its own.
 */
function recipeLines(host: Host, root: string): readonly CommandString[] {
  const path = makefileAt(host, root);
  const text = path === undefined ? undefined : readText(host, path);
  return (text ?? "")
    .replace(/\\\r?\n/gu, " ")
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("\t"))
    .map((line) => ({
      text: expandedByMake(line.slice(1).replace(/^[@+-]+/u, "")),
      dir: root,
    }));
}

/**
 * Every command the target root's workflow steps, git hooks, hook managers and makefile run:
 * the `run:` steps of the workflow files in `.github/workflows`, each file in `.husky` and
 * `.githooks` as one shell script, the `entry:` commands of `.pre-commit-config.yaml`, the
 * `run:` commands and the scripts of a lefthook file and the makefile's recipe lines.
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
    })),
    ...HOOK_MANAGERS.flatMap(({ name, key, dirKey, scripts }) => {
      const text = readText(host, joinPath(root, name)) ?? "";
      return [
        ...keyedCommands(text, root, key, dirKey),
        ...(scripts === true ? lefthookScripts(text, root) : []),
      ];
    }),
    ...recipeLines(host, root),
  ];
}

/**
 * The whole text of each file {@link workflowCommands} reads a command from, each workflow file,
 * git hook, hook manager file and makefile at the target root, which the dependency rule reads.
 */
export function commandFileTexts(host: Host, targetRoot: string): readonly string[] {
  return commandFiles(host, targetRoot).flatMap(({ path }) => readText(host, path) ?? []);
}

/** Each file {@link workflowCommands} reads a command from, with the key a YAML file writes its commands under. */
function commandFiles(
  host: Host,
  targetRoot: string,
): readonly { readonly path: string; readonly key: string | undefined }[] {
  const root = resolvePath(host.workingDirectory(), targetRoot);
  return [
    ...filesIn(host, joinPath(root, WORKFLOWS), (name) => /\.ya?ml$/u.test(name)).map((name) => ({
      path: joinPath(root, WORKFLOWS, name),
      key: "run",
    })),
    ...hookScripts(host, root).map((path) => ({ path, key: undefined })),
    ...HOOK_MANAGERS.map(({ name, key }) => ({ path: joinPath(root, name), key })),
    ...[makefileAt(host, root) ?? []].flat().map((path) => ({ path, key: undefined })),
  ];
}

/**
 * The filters of a workflow's `on` key, which name the files and refs whose change triggers it
 * and run none: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onpushpull_requestpull_request_targetpathspaths-ignore
 */
const TRIGGER_FILTERS = new Set([
  "paths",
  "paths-ignore",
  "branches",
  "branches-ignore",
  "tags",
  "tags-ignore",
]);

/**
 * The values of one YAML file that are no command, each with its key: every scalar but one
 * written under `key`, which is read as a command string, and one of a trigger filter. A file
 * `yamlDocument` does not read is one value, its whole text. No key and no comment is a value.
 */
function yamlValues(text: string, key: string): readonly HeldText[] {
  const document = yamlDocument(text);
  if (document === undefined) {
    return [{ text, shell: false }];
  }
  const found: HeldText[] = [];
  // `trigger` is 1 for the value of the top-level `on`, a map of events, and 2 for an event's.
  const visit = (node: unknown, under: string | undefined, trigger = 0): void => {
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item, under);
      }
    } else if (isRecord(node)) {
      for (const [name, value] of Object.entries(node)) {
        const on = node === document && (name === "on" || name === "true");
        if (
          (name !== key || scalarText(value) === undefined) &&
          !(trigger === 2 && TRIGGER_FILTERS.has(name))
        ) {
          visit(value, name, on ? 1 : trigger === 1 ? 2 : 0);
        }
      }
    } else {
      const value = scalarText(node);
      if (value !== undefined) {
        found.push({ text: value, shell: false, ...(under === undefined ? {} : { key: under }) });
      }
    }
  };
  visit(document, undefined);
  return found;
}

/**
 * The lines of a makefile that are no recipe line, joined with the lines a trailing `\`
 * continues them onto, each without the comment a `#` make does not read as escaped starts.
 */
function makefileValues(text: string): readonly HeldText[] {
  return text
    .replace(/\\\r?\n/gu, " ")
    .split(/\r?\n/u)
    .filter((line) => !line.startsWith("\t"))
    .map((line) => line.replace(/(?<!\\)#.*$/u, ""))
    .filter((line) => line.trim() !== "")
    .map((line) => ({ text: line, shell: false }));
}

/**
 * The texts layer 3 reads of the target root's command files: each command string, and each
 * value of a workflow file, a hook manager file and the makefile that is no command.
 */
function heldTexts(host: Host, targetRoot: string): readonly HeldText[] {
  const makefile = makefileAt(host, resolvePath(host.workingDirectory(), targetRoot));
  return [
    ...workflowCommands(host, targetRoot).map(({ text }) => ({ text, shell: true })),
    ...commandFiles(host, targetRoot).flatMap(({ path, key }) => {
      const text = readText(host, path);
      return text === undefined
        ? []
        : key !== undefined
          ? yamlValues(text, key)
          : path === makefile
            ? makefileValues(text)
            : [];
    }),
  ];
}

/** What the target root's workflow steps, git hooks, hook managers and makefile run, read once per run. */
export interface Workflows {
  /** Each command read. */
  readonly readings: readonly CommandReading[];
  /** The whole text of each file a command is read from, which the dependency rule reads. */
  readonly texts: readonly string[];
  /** What layer 3 reads of them: each command string, and each value that is no command. */
  readonly held: readonly HeldText[];
}

/** Reads the target root's workflow steps, git hooks, hook managers and makefile. */
export function readWorkflows(host: Host, targetRoot: string): Workflows {
  return {
    readings: workflowCommands(host, targetRoot).map(({ text, dir }) => readCommands(text, dir)),
    texts: commandFileTexts(host, targetRoot),
    held: heldTexts(host, targetRoot),
  };
}

/**
 * The own files the target root's workflow steps, git hooks and recipes run or name, as
 * `pathsNamed` reads each command.
 */
export function workflowEntries(
  workflows: Workflows,
  files: SourceFiles,
): readonly WorkflowEntry[] {
  const found: WorkflowEntry[] = [];
  for (const reading of workflows.readings) {
    for (const { path, written } of pathsNamed(reading)) {
      for (const file of files.named(path)) {
        found.push({ file, source: written });
      }
    }
  }
  return found;
}
