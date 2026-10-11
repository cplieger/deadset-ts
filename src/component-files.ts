/**
 * A component file read as markup holding script blocks, scanned only for what decides where
 * a block starts and ends. Its blocks become one module that keeps every block at its own
 * offsets and turns every other code unit but a line terminator into a space, so a position
 * of the module is the same position of the file. A default export and the imports a `src`
 * attribute names are appended past the file's end.
 */

/** The language one block is written in, as the module's virtual extension spells it. */
type BlockLanguage = "ts" | "tsx" | "js" | "jsx";

/** One block the module holds, the frontmatter included. */
interface Block {
  /** The offset the block's markup starts at: the `<` of its start tag, or 0 for frontmatter. */
  readonly tagStart: number;
  readonly contentStart: number;
  /** The offset one past the block's last code unit. */
  readonly contentEnd: number;
  readonly language: BlockLanguage;
}

/** One file a `<script src>` element names, which the module imports whole. */
interface SourceImport {
  /** The specifier the module imports, relative to the component file. */
  readonly specifier: string;
  /** The offsets of the `src` attribute, name and value. */
  readonly attributeStart: number;
  readonly attributeEnd: number;
}

/** A `<script` start tag beginning a line that the module holds no block for. */
interface ComponentWarning {
  /** The offset of the tag's `<`. */
  readonly offset: number;
  readonly reason: string;
}

/** One run of markup an expression or an attribute value is written in. */
interface MarkupAction {
  /** The offset of the run's first code unit. */
  readonly start: number;
  readonly text: string;
  /** The run as one line, the way an exemption record names its evidence. */
  readonly action: string;
}

/** What one component file's text is read as. */
interface ComponentFile {
  readonly blocks: readonly Block[];
  readonly imports: readonly SourceImport[];
  readonly warnings: readonly ComponentWarning[];
  /** Every expression and attribute value of the markup, in file order. */
  readonly markup: readonly MarkupAction[];
}

/** The module the compiler reads in place of one component file. */
interface ComponentModule {
  /** The module's text: the file's length, then what the module appends. */
  readonly text: string;
  /** The virtual extension: the strongest language any block names, `.ts` for none. */
  readonly extension: `.${BlockLanguage}`;
  /**
   * The span map in the compiler's tuple form: one verbatim segment per block and one
   * atom segment from each appended import to the attribute that names it.
   */
  readonly mappings: readonly (readonly [number, number, number, number, number])[];
}

const LANGUAGES: ReadonlyMap<string, BlockLanguage> = new Map([
  ["ts", "ts"],
  ["tsx", "tsx"],
  ["js", "js"],
  ["jsx", "jsx"],
]);

const STRENGTH: Readonly<Record<BlockLanguage, number>> = { js: 0, jsx: 1, ts: 2, tsx: 3 };

/** The `type` values a script element runs as a program under. */
const PROGRAM_TYPES: ReadonlySet<string> = new Set([
  "",
  "module",
  "text/javascript",
  "application/javascript",
  "text/ecmascript",
  "application/ecmascript",
  "text/typescript",
  "application/typescript",
]);

/** Elements with no content and no end tag. */
const VOID: ReadonlySet<string> = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

/** Elements whose content is text up to their own end tag. */
const RAW_TEXT: ReadonlySet<string> = new Set(["script", "style", "textarea", "title"]);

const VERBATIM = 0;
const ATOM = 1;

function isLetter(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d;
}

function isLineTerminator(code: number): boolean {
  return code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029;
}

function isNameCharacter(code: number): boolean {
  return (
    isLetter(code) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x2d ||
    code === 0x2e ||
    code === 0x3a ||
    code === 0x5f
  );
}

/** Whether the code unit at `offset` begins a line: the file's start, past a BOM, or after a line terminator. */
function beginsLine(text: string, offset: number): boolean {
  if (offset === 0 || (offset === 1 && text.charCodeAt(0) === 0xfeff)) {
    return true;
  }
  return isLineTerminator(text.charCodeAt(offset - 1));
}

/** The line one offset is on, counted from one, every line terminator the compiler counts ending a line. */
export function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let at = 0; at < offset && at < text.length; at += 1) {
    const code = text.charCodeAt(at);
    if (code === 0x0d && text.charCodeAt(at + 1) === 0x0a) {
      continue;
    }
    if (isLineTerminator(code)) {
      line += 1;
    }
  }
  return line;
}

/** The offset one past a tag name starting at `from`, or -1 where the `<` before it is text. */
function nameEnd(text: string, from: number): number {
  let at = from;
  while (at < text.length && isNameCharacter(text.charCodeAt(at))) {
    at += 1;
  }
  if (at === text.length) {
    return at;
  }
  const code = text.charCodeAt(at);
  return isSpace(code) || code === 0x2f || code === 0x3e ? at : -1;
}

/** The offset past the quoted string opening at `from`, or the text's length where it is not closed. */
function pastQuoted(text: string, from: number): number {
  const quote = text.charCodeAt(from);
  let at = from + 1;
  while (at < text.length && text.charCodeAt(at) !== quote) {
    at += text.charCodeAt(at) === 0x5c ? 2 : 1;
  }
  return Math.min(at + 1, text.length);
}

/** Whether a `<script` start tag begins a line at `offset`. */
function scriptTagAt(text: string, offset: number): boolean {
  return (
    text.charCodeAt(offset) === 0x3c &&
    beginsLine(text, offset) &&
    /^<script[\s/>]/iu.test(text.slice(offset, offset + 8))
  );
}

/**
 * The offset past the `}` matching the `{` at `from`, quoted strings skipped, or -1 where
 * none matches before the end or before a `<script` start tag that begins a line, so a
 * stray brace in markup never hides a block.
 */
function pastBraces(text: string, from: number): number {
  let depth = 0;
  let at = from;
  while (at < text.length) {
    const code = text.charCodeAt(at);
    if (scriptTagAt(text, at)) {
      return -1;
    }
    if (code === 0x22 || code === 0x27 || code === 0x60) {
      at = pastQuoted(text, at);
      continue;
    }
    if (code === 0x7b) {
      depth += 1;
    } else if (code === 0x7d) {
      depth -= 1;
      if (depth === 0) {
        return at + 1;
      }
    }
    at += 1;
  }
  return -1;
}

interface Attribute {
  readonly name: string;
  readonly value: string;
  readonly start: number;
  readonly end: number;
  /** The offset of the value's first code unit, inside its quotes or braces. */
  readonly valueStart: number;
}

interface StartTag {
  readonly name: string;
  readonly end: number;
  readonly selfClosing: boolean;
  readonly attributes: readonly Attribute[];
}

/** The start tag whose `<` is at `from`, to its `>`. A quoted or braced value may hold `>`. */
function readStartTag(text: string, from: number, nameStop: number): StartTag {
  const name = text.slice(from + 1, nameStop).toLowerCase();
  const attributes: Attribute[] = [];
  let at = nameStop;
  let selfClosing = false;
  while (at < text.length) {
    const code = text.charCodeAt(at);
    if (code === 0x3e) {
      return { name, end: at + 1, selfClosing, attributes };
    }
    if (isSpace(code)) {
      at += 1;
      continue;
    }
    if (code === 0x2f) {
      selfClosing = text.charCodeAt(at + 1) === 0x3e;
      at += 1;
      continue;
    }
    selfClosing = false;
    const start = at;
    if (code === 0x7b) {
      const past = pastBraces(text, at);
      at = past < 0 ? text.length : past;
      attributes.push({
        name: "",
        value: text.slice(start + 1, at - 1),
        start,
        end: at,
        valueStart: start + 1,
      });
      continue;
    }
    while (at < text.length) {
      const c = text.charCodeAt(at);
      if (isSpace(c) || c === 0x2f || c === 0x3e || (c === 0x3d && at > start)) {
        break;
      }
      at += 1;
    }
    const attribute = text.slice(start, at);
    while (at < text.length && isSpace(text.charCodeAt(at))) {
      at += 1;
    }
    let value = "";
    let valueStart = at;
    if (text.charCodeAt(at) === 0x3d) {
      at += 1;
      while (at < text.length && isSpace(text.charCodeAt(at))) {
        at += 1;
      }
      const opening = text.charCodeAt(at);
      if (opening === 0x22 || opening === 0x27) {
        const past = pastQuoted(text, at);
        valueStart = at + 1;
        value = text.slice(at + 1, Math.max(past - 1, at + 1));
        at = past;
      } else if (opening === 0x7b) {
        const past = pastBraces(text, at);
        const stop = past < 0 ? text.length : past;
        valueStart = at + 1;
        value = text.slice(at + 1, Math.max(stop - 1, at + 1));
        at = stop;
      } else {
        valueStart = at;
        while (at < text.length && !isSpace(text.charCodeAt(at)) && text.charCodeAt(at) !== 0x3e) {
          at += 1;
        }
        value = text.slice(valueStart, at);
      }
    } else {
      at = start + attribute.length;
    }
    attributes.push({ name: attribute.toLowerCase(), value, start, end: at, valueStart });
  }
  return { name, end: text.length, selfClosing, attributes };
}

/**
 * The offset of the `<` of the first end tag of `name` at or after `from`, case
 * ignored and followed by a space, a solidus or `>`, or the text's length where none is.
 */
function rawTextEnd(text: string, name: string, from: number): number {
  const lower = text.toLowerCase();
  const needle = `</${name}`;
  let at = lower.indexOf(needle, from);
  while (at >= 0) {
    const after = lower.charCodeAt(at + needle.length);
    if (Number.isNaN(after) || isSpace(after) || after === 0x2f || after === 0x3e) {
      return at;
    }
    at = lower.indexOf(needle, at + 1);
  }
  return text.length;
}

function pastClose(text: string, from: number): number {
  const close = text.indexOf(">", from);
  return close < 0 ? text.length : close + 1;
}

/** The frontmatter block, where the file's first line is `---` and a later line closes it. */
function frontmatter(text: string): Block | undefined {
  const start = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const lines = /\r\n|[\n\r\u2028\u2029]/gu;
  let lineStart = start;
  let index = 0;
  for (;;) {
    lines.lastIndex = lineStart;
    const match = lines.exec(text);
    const lineEnd = match === null ? text.length : match.index;
    const isFence = /^---[ \t]*$/u.test(text.slice(lineStart, lineEnd));
    if (index === 0 && !isFence) {
      return undefined;
    }
    if (index > 0 && isFence) {
      return {
        tagStart: 0,
        contentStart: lineStartOf(text, start),
        contentEnd: lineStart,
        language: "ts",
      };
    }
    if (match === null) {
      return undefined;
    }
    lineStart = match.index + match[0].length;
    index += 1;
  }
}

/** The offset past the first line that starts at `from`. */
function lineStartOf(text: string, from: number): number {
  const lines = /\r\n|[\n\r\u2028\u2029]/gu;
  lines.lastIndex = from;
  const match = lines.exec(text);
  return match === null ? text.length : match.index + match[0].length;
}

/** The text of one action, collapsed to a line. */
function actionOf(text: string): string {
  return text.trim().replace(/\s+/gu, " ");
}

/** Whether a `src` value names a file: no scheme, no root-relative path, not empty. */
function specifierOf(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.startsWith("/") || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(trimmed)) {
    return undefined;
  }
  return trimmed.startsWith("./") || trimmed.startsWith("../") ? trimmed : `./${trimmed}`;
}

/** The line-start `<script` tags one block's content holds. */
function scriptsInside(text: string, from: number, to: number): number[] {
  const found: number[] = [];
  const pattern = /<script(?=[\s/>])/giu;
  pattern.lastIndex = from;
  for (
    let match = pattern.exec(text);
    match !== null && match.index < to;
    match = pattern.exec(text)
  ) {
    if (beginsLine(text, match.index)) {
      found.push(match.index);
    }
  }
  return found;
}

/**
 * The blocks, the source imports, the warnings and the markup actions of one component file.
 * The scan keeps a stack of open elements. A comment, a doctype or processing instruction and
 * an expression in braces are text, and an end tag closes back to the nearest open element of
 * its name. A raw-text element at the top level runs to its own end tag, and only a `script`
 * element whose start tag begins a line at the top level is a block.
 */
export function readComponent(text: string): ComponentFile {
  const blocks: Block[] = [];
  const imports: SourceImport[] = [];
  const warnings: ComponentWarning[] = [];
  const markup: MarkupAction[] = [];
  const front = frontmatter(text);
  if (front !== undefined) {
    blocks.push(front);
  }
  const open: string[] = [];
  let at = front === undefined ? 0 : lineStartOf(text, front.contentEnd);
  while (at < text.length) {
    const code = text.charCodeAt(at);
    if (code === 0x7b) {
      const past = pastBraces(text, at);
      if (past < 0) {
        at += 1;
        continue;
      }
      const inner = text.slice(at + 1, past - 1);
      markup.push({ start: at + 1, text: inner, action: actionOf(text.slice(at, past)) });
      at = past;
      continue;
    }
    if (code !== 0x3c) {
      at += 1;
      continue;
    }
    const lt = at;
    if (text.startsWith("<!--", lt)) {
      const close = text.indexOf("-->", lt + 4);
      at = close < 0 ? text.length : close + 3;
      continue;
    }
    const next = text.charCodeAt(lt + 1);
    if (next === 0x21 || next === 0x3f) {
      at = pastClose(text, lt + 2);
      continue;
    }
    if (next === 0x2f && isLetter(text.charCodeAt(lt + 2))) {
      const stop = nameEnd(text, lt + 2);
      if (stop >= 0) {
        const depth = open.lastIndexOf(text.slice(lt + 2, stop).toLowerCase());
        if (depth >= 0) {
          open.length = depth;
        }
        at = pastClose(text, stop);
        continue;
      }
    }
    const nameStop = isLetter(next) ? nameEnd(text, lt + 1) : -1;
    if (nameStop < 0) {
      at = lt + 1;
      continue;
    }
    const tag = readStartTag(text, lt, nameStop);
    const rawText = open.length === 0 && RAW_TEXT.has(tag.name);
    for (const attribute of rawText ? [] : tag.attributes) {
      if (attribute.value !== "") {
        markup.push({
          start: attribute.valueStart,
          text: attribute.value,
          action: actionOf(text.slice(attribute.start, attribute.end)),
        });
      }
    }
    const line = beginsLine(text, lt);
    if (tag.name === "script" && line && open.length > 0) {
      warnings.push({ offset: lt, reason: "it is inside an element" });
    }
    if (rawText) {
      const contentEnd = tag.selfClosing ? tag.end : rawTextEnd(text, tag.name, tag.end);
      if (tag.name === "script" && line) {
        script(tag, lt, contentEnd);
      }
      at =
        tag.selfClosing || contentEnd >= text.length
          ? Math.max(tag.end, contentEnd)
          : pastClose(text, contentEnd + 2);
      continue;
    }
    if (!tag.selfClosing && !VOID.has(tag.name)) {
      open.push(tag.name);
    }
    at = tag.end;
  }
  return { blocks, imports, warnings: warnings.sort((a, b) => a.offset - b.offset), markup };

  /** Reads one top-level script element that begins a line. */
  function script(tag: StartTag, lt: number, contentEnd: number): void {
    const attribute = (name: string): Attribute | undefined =>
      tag.attributes.find((one) => one.name === name);
    const src = attribute("src");
    if (src !== undefined) {
      const specifier = specifierOf(src.value);
      if (specifier === undefined) {
        warnings.push({ offset: lt, reason: `its src ${JSON.stringify(src.value)} names no file` });
      } else {
        imports.push({ specifier, attributeStart: src.start, attributeEnd: src.end });
      }
      return;
    }
    const type = (attribute("type")?.value ?? "").trim().toLowerCase();
    if (!PROGRAM_TYPES.has(type)) {
      warnings.push({
        offset: lt,
        reason: `its type ${JSON.stringify(type)} is not a script type`,
      });
      return;
    }
    const lang = attribute("lang")?.value.trim().toLowerCase();
    const language = lang === undefined ? "js" : LANGUAGES.get(lang);
    if (language === undefined) {
      warnings.push({
        offset: lt,
        reason: `its lang ${JSON.stringify(lang)} is not ts, tsx, js or jsx`,
      });
      return;
    }
    if (tag.selfClosing) {
      return;
    }
    for (const inside of scriptsInside(text, tag.end, contentEnd)) {
      warnings.push({ offset: inside, reason: "it begins a line inside a block" });
    }
    blocks.push({ tagStart: lt, contentStart: tag.end, contentEnd, language });
  }
}

/**
 * Whether the module's text exports a default at its top level: an `export default`
 * or an export clause naming `default`, outside every comment, string, template and
 * regular expression, and outside every bracket.
 */
export function exportsDefault(text: string): boolean {
  const words: string[] = [];
  let depth = 0;
  let clause = false;
  let previous = "";
  let at = 0;
  const regexMayStart = (): boolean =>
    previous === "" ||
    /^[([{,;:?=!&|+\-*%<>~^]$/u.test(previous) ||
    /^(return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/u.test(
      previous,
    );
  const skipTemplate = (from: number): number => {
    let index = from + 1;
    while (index < text.length) {
      const c = text.charCodeAt(index);
      if (c === 0x5c) {
        index += 2;
        continue;
      }
      if (c === 0x60) {
        return index + 1;
      }
      if (c === 0x24 && text.charCodeAt(index + 1) === 0x7b) {
        const past = pastBraces(text, index + 1);
        index = past < 0 ? text.length : past;
        continue;
      }
      index += 1;
    }
    return index;
  };
  while (at < text.length) {
    const c = text.charCodeAt(at);
    const pair = text.slice(at, at + 2);
    if (pair === "//") {
      while (at < text.length && !isLineTerminator(text.charCodeAt(at))) {
        at += 1;
      }
      continue;
    }
    if (pair === "/*") {
      const close = text.indexOf("*/", at + 2);
      at = close < 0 ? text.length : close + 2;
      continue;
    }
    if (c === 0x22 || c === 0x27) {
      at = pastQuoted(text, at);
      previous = "string";
      continue;
    }
    if (c === 0x60) {
      at = skipTemplate(at);
      previous = "string";
      continue;
    }
    if (c === 0x2f && regexMayStart()) {
      let index = at + 1;
      let inClass = false;
      while (index < text.length && !isLineTerminator(text.charCodeAt(index))) {
        const r = text.charCodeAt(index);
        if (r === 0x5c) {
          index += 2;
          continue;
        }
        if (r === 0x5b) {
          inClass = true;
        } else if (r === 0x5d) {
          inClass = false;
        } else if (r === 0x2f && !inClass) {
          break;
        }
        index += 1;
      }
      at = index + 1;
      previous = "regex";
      continue;
    }
    if (isSpace(c) || isLineTerminator(c)) {
      at += 1;
      continue;
    }
    const word = /[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*/uy;
    word.lastIndex = at;
    const matched = word.exec(text);
    if (matched !== null) {
      const name = matched[0];
      if (depth === 0 && words.at(-1) === "export" && name === "default") {
        return true;
      }
      if (clause && name === "default") {
        return true;
      }
      words.push(name);
      previous = name;
      at += name.length;
      continue;
    }
    const char = text[at] ?? "";
    if (char === "{" || char === "(" || char === "[") {
      clause = depth === 0 && char === "{" && words.at(-1) === "export";
      depth += 1;
    } else if (char === "}" || char === ")" || char === "]") {
      depth = Math.max(depth - 1, 0);
      if (depth === 0) {
        clause = false;
      }
    }
    words.push(char);
    previous = char;
    at += 1;
  }
  return false;
}

/** The module one component file's text is read as, and the span map back to the file. */
export function componentModule(text: string): ComponentModule {
  const { blocks, imports } = readComponent(text);
  const out: string[] = [];
  let at = 0;
  let language: BlockLanguage | undefined;
  const mask = (from: number, to: number, statementBreak: boolean): void => {
    for (let index = from; index < to; index += 1) {
      const code = text.charCodeAt(index);
      if (isLineTerminator(code) || (index === 0 && code === 0xfeff)) {
        out.push(text[index] ?? "");
      } else if (statementBreak && index === from) {
        out.push(";");
      } else {
        out.push(" ");
      }
    }
  };
  const mappings: [number, number, number, number, number][] = [];
  for (const block of blocks) {
    if (language === undefined || STRENGTH[block.language] > STRENGTH[language]) {
      language = block.language;
    }
    mask(at, block.tagStart, false);
    mask(block.tagStart, block.contentStart, at > 0);
    out.push(text.slice(block.contentStart, block.contentEnd));
    const length = block.contentEnd - block.contentStart;
    if (length > 0) {
      mappings.push([block.contentStart, length, block.contentStart, length, VERBATIM]);
    }
    at = block.contentEnd;
  }
  mask(at, text.length, false);
  const extension = `.${language ?? "ts"}` as const;
  const typed = extension === ".ts" || extension === ".tsx";
  let module = out.join("");
  const tail: string[] = [];
  if (!exportsDefault(module)) {
    tail.push(typed ? "export default (0 as any);" : "export default {};");
  }
  module += `\n${tail.join("\n")}`;
  imports.forEach((one, index) => {
    const statement = `import * as __component_src_${String(index)} from ${JSON.stringify(one.specifier)};`;
    module += "\n";
    mappings.push([
      module.length,
      statement.length,
      one.attributeStart,
      one.attributeEnd - one.attributeStart,
      ATOM,
    ]);
    module += statement;
  });
  return { text: `${module}\n`, extension, mappings };
}
