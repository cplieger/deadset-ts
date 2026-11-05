/**
 * The sources that enter a project's files with no import naming them, read once per
 * project into one record every stage reads: the roots stage reads the files they enter,
 * the dependency stage the configuration files' strings, and the reference pass the test
 * files. A value a source does not find written out names nothing.
 */

import type { SourceFile } from "@typescript/native/ast";
import { buildScriptEntries } from "./build-scripts.ts";
import {
  configurationFiles,
  filesNamedBy,
  moduleStrings,
  type ConfigurationFiles,
  type ParseFile,
} from "./configuration-files.ts";
import {
  conventionEntries,
  conventionTestFiles,
  generatedFiles,
  type Conventions,
  type Selected,
} from "./conventions.ts";
import type { Host } from "../host.ts";
import { htmlEntries } from "./html-entries.ts";
import { documentEntries } from "./mdx-entries.ts";
import { dirnamePath } from "../paths.ts";
import type { SourceFiles } from "../source-files.ts";
import { globExpression } from "../text/glob.ts";
import { workflowEntries, type Workflows } from "./workflow-steps.ts";

/** Which source entered a file. */
export type EntryRule =
  /** A configuration module, by the form of its name. */
  | "configuration-file"
  /** A file a relative string of a configuration module or a JSON configuration file names. */
  | "configuration-string"
  /** An entry a build script's bundler call names, whose exports the bundle exposes. */
  | "bundler-entry"
  /** A test file `ts.test_files` or an applied convention row names. */
  | "test-runner"
  /** A file an applied convention row's globs match. */
  | "convention"
  /** A file a module script of an HTML file below the target root loads. */
  | "html-entry"
  /** A file a `run:` step of a workflow in the target root's `.github/workflows` names. */
  | "workflow-step"
  /** A file an import line of a Markdown or MDX document below the target root names. */
  | "document-import";

/** One file a source enters. */
interface EntryPoint {
  readonly file: SourceFile;
  readonly rule: EntryRule;
  /**
   * What named the file: the file-name convention the tool looks for, the row, the
   * test-file pattern or string that classified it, or the literal a configuration or a
   * call writes.
   */
  readonly source: string;
  /**
   * Whether what the file exports is read too. A tool loading a configuration reads its
   * default export; a runtime executing a test file runs its top level and names none of
   * its exports.
   */
  readonly exports: boolean;
  /** Where the file is entered for some of its exports only, their export names. */
  readonly names?: readonly string[];
}

/** What the sources of one project are read from. */
interface SourceContext {
  readonly host: Host;
  readonly targetRoot: string;
  readonly files: SourceFiles;
  /** The parser the files no program holds are read with, where they are read. */
  readonly parse?: ParseFile | undefined;
  /** `ts.test_files` from the resolved configuration. */
  readonly testFiles: readonly string[];
  /** The convention rows the run applied. */
  readonly conventions?: Conventions | undefined;
  /** The target root's workflow steps, git hooks and makefile, read once per run. */
  readonly workflows: Workflows;
}

/** What the sources of one project enter and name. */
export interface SourceFacts {
  /** Every file a source enters, once per source and string that enters it. */
  readonly entered: readonly EntryPoint[];
  /** The files, absolute, a test runner loads. */
  readonly testFiles: ReadonlySet<string>;
  /** The own files below a directory an applied row generates, by path below the target root, each with the row. */
  readonly generated: ReadonlyMap<string, string>;
  /** The configuration files, whose strings name files and dependencies. */
  readonly configuration: ConfigurationFiles;
  /** The target root's workflow steps, git hooks and makefile the entries were read from. */
  readonly workflows: Workflows;
}

/** One file a test runner loads, and the pattern or string naming it. */
interface TestFile {
  readonly file: SourceFile;
  readonly source: string;
}

/** What every source reads: the context, and the configuration files and test files read once. */
interface SourceInput extends SourceContext {
  readonly configuration: ConfigurationFiles;
  readonly tests: readonly TestFile[];
}

/** One source: the files it enters in one project. */
type EntrySource = (input: SourceInput) => readonly EntryPoint[];

/**
 * Each configuration module, with what it exports, and each own file a relative string of
 * a configuration module or a JSON configuration file names, read against that file's
 * directory. A string at a selection key of an applied convention row, or naming a test
 * file, names no file here.
 */
const configurationSource: EntrySource = ({ files, configuration, conventions }) => {
  const selected: ReadonlyMap<string, Selected> = conventions?.selected ?? new Map();
  const found: EntryPoint[] = [];
  const unselected = (file: SourceFile): readonly string[] => {
    const starts = selected.get(file.fileName)?.starts;
    return moduleStrings(file)
      .filter((one) => starts?.has(one.node.getStart()) !== true)
      .map((one) => one.text);
  };
  const unselectedIn = (path: string, texts: readonly string[]): readonly string[] => {
    const left = [...(selected.get(path)?.texts ?? [])];
    return texts.filter((text) => {
      const at = left.indexOf(text);
      if (at < 0) {
        return true;
      }
      left.splice(at, 1);
      return false;
    });
  };
  const strings = (dir: string, texts: readonly string[]): void => {
    for (const text of texts) {
      for (const file of filesNamedBy(files, dir, text)) {
        found.push({ file, rule: "configuration-string", source: text, exports: true });
      }
    }
  };
  for (const { file, form } of configuration.modules) {
    found.push({ file, rule: "configuration-file", source: form, exports: true });
    strings(dirnamePath(file.fileName), unselected(file));
  }
  for (const document of configuration.documents) {
    strings(dirnamePath(document.path), unselectedIn(document.path, document.strings));
  }
  for (const { file } of configuration.outside) {
    strings(dirnamePath(file.fileName), unselected(file));
  }
  return found;
};

const testSource: EntrySource = ({ tests }) =>
  tests.map(({ file, source }) => ({ file, rule: "test-runner", source, exports: false }));

const conventionSource: EntrySource = ({ files, conventions }) =>
  conventions === undefined
    ? []
    : conventionEntries(conventions, files).map(({ file, row }) => ({
        file,
        rule: "convention",
        source: row,
        exports: true,
      }));

const htmlSource: EntrySource = ({ host, targetRoot, files, parse }) =>
  htmlEntries(host, targetRoot, files, parse).map(({ file, source }) => ({
    file,
    rule: "html-entry",
    source,
    exports: true,
  }));

const documentSource: EntrySource = ({ host, targetRoot, files }) =>
  documentEntries(host, targetRoot, files).map(({ file, source, names }) => ({
    file,
    rule: "document-import",
    source,
    exports: true,
    ...(names === undefined ? {} : { names }),
  }));

const buildScriptSource: EntrySource = ({ host, targetRoot, files, parse }) =>
  buildScriptEntries(host, targetRoot, files, parse).map(({ file, source }) => ({
    file,
    rule: "bundler-entry",
    source,
    exports: true,
  }));

const workflowSource: EntrySource = ({ workflows, files }) =>
  workflowEntries(workflows, files).map(({ file, source }) => ({
    file,
    rule: "workflow-step",
    source,
    exports: true,
  }));

/** Every source, each read once per project. */
const ENTRY_SOURCES: readonly EntrySource[] = [
  configurationSource,
  conventionSource,
  testSource,
  htmlSource,
  documentSource,
  buildScriptSource,
  workflowSource,
];

/**
 * The files a test runner loads in one project: each `ts.test_files` pattern's matches
 * below the target root, then each file an applied row names, once per pattern or row
 * string that names it.
 */
function testFilesOf(context: SourceContext): readonly TestFile[] {
  const found: TestFile[] = [];
  for (const pattern of context.testFiles) {
    const expression = globExpression(pattern);
    for (const [path, file] of context.files.byPath) {
      if (expression.test(path)) {
        found.push({ file, source: pattern });
      }
    }
  }
  const named =
    context.conventions === undefined
      ? []
      : conventionTestFiles(context.conventions, context.files);
  for (const [name, source] of named) {
    const file = context.files.byName.get(name);
    if (file !== undefined) {
      found.push({ file, source });
    }
  }
  return found;
}

/** Reads every source of one project once. */
export function readSources(context: SourceContext): SourceFacts {
  const configuration = configurationFiles(
    context.host,
    context.targetRoot,
    context.files,
    context.parse,
  );
  const tests = testFilesOf(context);
  const input: SourceInput = { ...context, configuration, tests };
  return {
    entered: ENTRY_SOURCES.flatMap((source) => source(input)),
    testFiles: new Set(tests.map(({ file }) => file.fileName)),
    generated:
      context.conventions === undefined
        ? new Map()
        : generatedFiles(context.conventions, context.files),
    configuration,
    workflows: context.workflows,
  };
}
