/**
 * The template-field class: a member is held back, at the lowest confidence, when a
 * template under a configured template directory writes its name inside an action,
 * because a template engine reads the member by that name at run time.
 *
 * Every file under a configured directory is a template. An action runs from an
 * opening delimiter to the first closing one after it, at the pair
 * `analysis.template_delimiters` sets, `{{` and `}}` by default, and each identifier
 * it writes outside a quoted string is a name it reads: `{{ user.name }}` names `user`
 * and `name`. A file holding an unclosed action names nothing. A name reaches the
 * instance members of classes and the members of interfaces and object types, on any
 * type, because nothing ties the name to a type.
 */

import { readComponent } from "./component-files.ts";
import { ConfigError, type Analysis, type TemplateDelimiters } from "./config.ts";
import type { DetectorInput, Evidence } from "./exempt.ts";
import type { Host } from "./host.ts";
import type { SymbolKind } from "./inventory.ts";
import { memberNames } from "./member-names.ts";
import { isAbsolutePath, joinPath, normalizePath, relativePath } from "./paths.ts";
import { isComponentFile, type Position } from "./position.ts";

/** One template, by its path below the target root. */
export interface TemplateFile {
  readonly path: string;
  readonly text: string;
}

/** The templates one run scans, and the pair their actions are written with. */
export interface Templates {
  readonly delimiters: TemplateDelimiters;
  readonly files: readonly TemplateFile[];
}

/** The kinds of declaration an action can name. */
const READ_BY_A_TEMPLATE: ReadonlySet<SymbolKind> = new Set([
  "method",
  "class-member",
  "interface-method",
  "type-member",
]);

/**
 * The kinds of declaration a component file's markup can name. Its expressions are the
 * language's own, so a static member and an enum member are reachable by name too.
 */
const READ_BY_MARKUP: ReadonlySet<SymbolKind> = new Set([...READ_BY_A_TEMPLATE, "enum-member"]);

/** One identifier, as the grammar of the analyzed language spells one. */
const IDENTIFIER = /[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*/uy;

/** Two strings ordered bytewise. */
function compare(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/**
 * Every template under the configured directories, read once for the run, in path
 * order and each file once. A directory is named relative to the target root, and
 * one the target does not hold refuses the run as a usage error: the class would
 * scan nothing, so a name that no longer matches the tree would silently switch the
 * exemption it was configured for off. A symbolic link to a directory is not
 * followed.
 */
export function readTemplates(host: Host, targetRoot: string, analysis: Analysis): Templates {
  const files = new Map<string, string>();
  const read = (dir: string): void => {
    const entries = [...host.readDirectory(joinPath(targetRoot, dir))].sort((a, b) =>
      compare(a.name, b.name),
    );
    for (const entry of entries) {
      const path = joinPath(dir, entry.name);
      if (entry.directory) {
        read(path);
        continue;
      }
      const absolute = joinPath(targetRoot, path);
      if (!files.has(path) && host.kindOf(absolute) === "file") {
        files.set(path, host.readFile(absolute));
      }
    }
  };
  for (const configured of analysis.templateDirs) {
    const dir = normalizePath(configured);
    if (
      isAbsolutePath(dir) ||
      dir === ".." ||
      dir.startsWith("../") ||
      host.kindOf(joinPath(targetRoot, dir)) !== "directory"
    ) {
      throw new ConfigError(
        "malformed",
        "analysis.template_dirs",
        `analysis.template_dirs: ${JSON.stringify(configured)} is not a directory below the target root`,
      );
    }
    read(dir);
  }
  return {
    delimiters: analysis.templateDelimiters,
    files: [...files]
      .map(([path, text]) => ({ path, text }))
      .sort((a, b) => compare(a.path, b.path)),
  };
}

/** One identifier an action writes, where it is written, and the action that writes it. */
interface Named {
  readonly name: string;
  readonly offset: number;
  readonly action: string;
}

/** The end of the quoted string that opens at `from`, past its closing quote. */
function stringEnd(text: string, from: number): number {
  const quote = text[from];
  let at = from + 1;
  while (at < text.length && text[at] !== quote) {
    at += text[at] === "\\" ? 2 : 1;
  }
  return at + 1;
}

/** The end of the `${` substitution whose expression starts at `from`, past its closing brace. */
function substitutionEnd(text: string, from: number): number {
  let depth = 1;
  let at = from;
  while (at < text.length) {
    const char = text[at];
    if (char === '"' || char === "'") {
      at = stringEnd(text, at);
      continue;
    }
    if (char === "`") {
      at = templateEnd(text, at, () => undefined);
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return at + 1;
      }
    }
    at += 1;
  }
  return at;
}

/** The end of the template literal at `from`; each `${…}` expression goes to `substitution`. */
function templateEnd(
  text: string,
  from: number,
  substitution: (expression: string, offset: number) => void,
): number {
  let at = from + 1;
  while (at < text.length && text[at] !== "`") {
    if (text[at] === "\\") {
      at += 2;
      continue;
    }
    if (text[at] === "$" && text[at + 1] === "{") {
      const start = at + 2;
      const end = substitutionEnd(text, start);
      substitution(text.slice(start, end - 1), start);
      at = end;
      continue;
    }
    at += 1;
  }
  return at + 1;
}

/**
 * The identifiers one action's inner text writes outside a quoted string, with their offsets
 * in it. In `script` text, a component's markup, a template literal's substitutions are code.
 */
function identifiersOf(inner: string, script = false): readonly { name: string; offset: number }[] {
  const found: { name: string; offset: number }[] = [];
  let at = 0;
  while (at < inner.length) {
    const char = inner[at] ?? "";
    if (char === "`" && script) {
      at = templateEnd(inner, at, (expression, offset) => {
        for (const one of identifiersOf(expression, true)) {
          found.push({ name: one.name, offset: offset + one.offset });
        }
      });
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      at = stringEnd(inner, at);
      continue;
    }
    if (/[0-9]/u.test(char)) {
      // A number's letters are part of the number: `1e3` names nothing.
      while (at < inner.length && /[0-9A-Za-z_.]/u.test(inner[at] ?? "")) {
        at += 1;
      }
      continue;
    }
    IDENTIFIER.lastIndex = at;
    const match = IDENTIFIER.exec(inner);
    if (match !== null) {
      found.push({ name: match[0], offset: at });
      at += match[0].length;
      continue;
    }
    at += 1;
  }
  return found;
}

/**
 * Every identifier one template's actions write, in the order the file writes them,
 * or none where an action is not closed.
 */
function namesOf(text: string, delimiters: TemplateDelimiters): readonly Named[] {
  const found: Named[] = [];
  let from = 0;
  for (;;) {
    const open = text.indexOf(delimiters.left, from);
    if (open < 0) {
      return found;
    }
    const start = open + delimiters.left.length;
    const close = text.indexOf(delimiters.right, start);
    if (close < 0) {
      return [];
    }
    const inner = text.slice(start, close);
    const action = `${delimiters.left}${inner.trim().replace(/\s+/gu, " ")}${delimiters.right}`;
    for (const { name, offset } of identifiersOf(inner)) {
      found.push({ name, offset: start + offset, action });
    }
    from = close + delimiters.right.length;
  }
}

/** Every identifier the markup of one component file writes in an action. */
function markupNamesOf(text: string): readonly Named[] {
  return readComponent(text).markup.flatMap((one) =>
    identifiersOf(one.text, true).map(({ name, offset }) => ({
      name,
      offset: one.start + offset,
      action: one.action,
    })),
  );
}

/** Where one offset of a template is, its column counted in UTF-16 code units. */
function positionIn(file: TemplateFile, offset: number): Position {
  const before = file.text.slice(0, offset);
  const lineStart = before.lastIndexOf("\n") + 1;
  return {
    path: file.path,
    line: before.split("\n").length,
    column: offset - lineStart + 1,
  };
}

/**
 * The template-field detector: every instance member of a class and every member of
 * an interface or an object type whose name an action of a configured template
 * writes, and every member of those and of an enum whose name a component file's
 * markup writes, recorded at the identifier and held while that file is live.
 */
export function templateField<Brand>(input: DetectorInput<Brand>): readonly Evidence[] {
  const { templates } = input;
  const components = input.project.ownSourceFiles().flatMap((file) => {
    const path = isComponentFile(file) ? relativePath(input.targetRoot, file.fileName) : undefined;
    return path === undefined ? [] : [{ path, text: file.originalText }];
  });
  if (templates.files.length === 0 && components.length === 0) {
    return [];
  }
  const members = memberNames(input.project.ownSourceFiles(), input.held);
  const found: Evidence[] = [];
  const scanned = [
    ...templates.files.map((file) => ({
      file,
      names: namesOf(file.text, templates.delimiters),
      markup: false,
    })),
    ...components.map((file) => ({ file, names: markupNamesOf(file.text), markup: true })),
  ];
  for (const { file, names, markup } of scanned) {
    for (const named of names) {
      for (const member of members.get(named.name) ?? []) {
        const readable = markup
          ? READ_BY_MARKUP.has(member.kind)
          : READ_BY_A_TEMPLATE.has(member.kind) && !member.static;
        if (!readable) {
          continue;
        }
        found.push({
          id: member.id,
          detail: `named by ${named.action}`,
          site: positionIn(file, named.offset),
          ...(markup ? { whileLive: file.path } : {}),
        });
      }
    }
  }
  return found;
}
