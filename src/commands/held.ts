/**
 * The words layer 3 of the command reader reads: each word of a command string as the vendored
 * shell parser reads it, and each token of a value of a command file that is no command, each
 * with whether it may write the file a command runs. `text/named-files.ts` reads the files
 * they name. Comments and keys are never words.
 */

import {
  forEachChild,
  parse,
  type CommandNode,
  type ParsedScript,
  type Redirection,
  type SyntaxNode,
  type Word as ShellWord,
} from "../vendor/unbash/parser.ts";
import { expressionsAsParts, heldTextsOf, parseLine, PART, wordOf, type Word } from "./shell.ts";
import { fileOperands, outputOf } from "./tools.ts";

/** One text layer 3 reads. */
export interface HeldText {
  readonly text: string;
  /** Whether a shell runs it: a command string, rather than a value that is no command. */
  readonly shell: boolean;
  /** The key a YAML value is written under. */
  readonly key?: string;
  /** Whether it is a manifest's script, whose `node --test` runs the files tests.1 roots. */
  readonly tested?: boolean;
}

/** One word layer 3 reads, each part only the run knows in it written as {@link PART}. */
export interface HeldWord {
  readonly text: string;
  /** Whether it may write the file a command runs or a module a runtime loads before it. */
  readonly runs: boolean;
}

/** A `uses:` value that references a repository's action, never a local path (https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idstepsuses). */
const ACTION_REFERENCE = /^[\w-][\w.-]*\/[\w.-]+(?:\/[\w.-]+)*@[\w./-]+$/u;

/** The word of a command whose runtime runs a file no word of it writes, as another program hands it the path. */
const UNWRITTEN: HeldWord = { text: PART, runs: true };

/**
 * What a command's standard input carries, as far as the line shows it: the file a `<` or `<>`
 * names; the text of a here-document or here-string, command lines to a shell and code to a
 * runtime; the lines a command before it in a pipeline writes, as {@link outputOf} reads them;
 * and whether it carries what no row reads, another program's output.
 */
interface Stdin {
  readonly file?: Word;
  readonly content: readonly string[];
  readonly piped: readonly string[];
  readonly unknown: boolean;
}

const NO_STDIN: Stdin = { content: [], piped: [], unknown: false };

const UNKNOWN_STDIN: Stdin = { ...NO_STDIN, unknown: true };

/** Whether `redirect` reads into descriptor 0, the default of `<`, `<>`, `<&`, `<<` and `<<<`. */
function readsInput(redirect: Redirection): boolean {
  const { descriptor } = redirect;
  return (
    (redirect.type !== "Redirect" || ["<", "<>", "<&"].includes(redirect.operator)) &&
    (descriptor === undefined || (descriptor.type === "FileDescriptor" && descriptor.value === 0))
  );
}

/**
 * The standard input `redirects` give a command, the last that reads descriptor 0 deciding as
 * the shell applies them in order, or `inherited` where none does. A `<&` duplicates a
 * descriptor the line does not show.
 */
function stdinOf(redirects: readonly Redirection[], inherited: Stdin): Stdin {
  const last = redirects.findLast(readsInput);
  if (last === undefined) {
    return inherited;
  }
  switch (last.type) {
    case "HereDoc":
      return { ...NO_STDIN, content: [last.body.text] };
    case "HereString":
      return { ...NO_STDIN, content: last.target === undefined ? [] : heldTextsOf(last.target) };
    default:
      return last.operator === "<&" || last.target === undefined
        ? UNKNOWN_STDIN
        : { ...NO_STDIN, file: wordOf(last.target) };
  }
}

/** The words of a simple command, its program word first. */
function wordsOf(node: CommandNode): readonly ShellWord[] {
  return node.type === "Command" && node.name !== undefined
    ? [node.name, ...node.suffix.filter((part) => part.type === "Word")]
    : [];
}

/** What the pipeline member `member`, whose own standard input `inputs` holds, writes to the next, as {@link outputOf} reads it. */
function pipedFrom(member: CommandNode, inputs: ReadonlyMap<SyntaxNode, Stdin>): Stdin {
  const words = wordsOf(member);
  const output = words.length === 0 ? undefined : outputOf(words.map(wordOf));
  if (output === undefined) {
    return UNKNOWN_STDIN;
  }
  const own = output.input ? (inputs.get(member) ?? NO_STDIN) : NO_STDIN;
  const textsAt = (at: number): readonly string[] => {
    const word = words[at];
    return word === undefined ? [] : heldTextsOf(word);
  };
  const lines = [
    ...output.at.flatMap(textsAt),
    ...output.joined.map(([from, to]) =>
      words
        .slice(from, to)
        .flatMap((_, at) => textsAt(from + at))
        .join(" "),
    ),
    ...output.texts,
  ];
  return { ...own, piped: [...own.piped, ...lines] };
}

/** How many times a quoted text, a here-document's body or a `-c` value is read as a command line in turn. */
const DEPTH = 4;

/** A `\\` a path may hold: none that ends a line, nor one before a backquote, which it escapes. */
const BACKSLASH_PATH = /\\(?![\r\n`])/gu;

/** Text a shell may read as more than one word: a blank or an operator. */
const LINE_SYNTAX = /[\s;&|<>()]/u;

/** A shell parameter's name, or a special parameter, after its `$`. */
const PARAMETER = /[A-Za-z_]\w*|[0-9@*#?!$-]/uy;

/** The place after the brackets that open at `at`, nested ones included, or the text's end. */
function closing(text: string, at: number, open: string, close: string): number {
  let depth = 0;
  for (let next = at; next < text.length; next += 1) {
    depth += text.charAt(next) === open ? 1 : text.charAt(next) === close ? -1 : 0;
    if (depth === 0) {
      return next + 1;
    }
  }
  return text.length;
}

/** The text inside each outermost command substitution `text`, a line that does not parse, writes. */
function substitutions(text: string): readonly string[] {
  const found: string[] = [];
  for (let at = text.indexOf("$("); at >= 0; at = text.indexOf("$(", at + 1)) {
    const end = closing(text, at + 1, "(", ")");
    found.push(text.slice(at + 2, text.charAt(end - 1) === ")" ? end - 1 : end));
    at = end - 1;
  }
  return found;
}

/**
 * `text`, a line that does not parse, with each expansion it writes as a part: a parameter
 * expansion, a command substitution or an arithmetic expansion to its matching bracket, and
 * a backquoted command to its closing backquote, each to the text's end where none closes it.
 */
function expansionsAsParts(text: string): string {
  let read = "";
  for (let at = 0; at < text.length; at += 1) {
    const char = text.charAt(at);
    const next = text.charAt(at + 1);
    let end = at;
    if (char === "`") {
      const close = text.indexOf("`", at + 1);
      end = close < 0 ? text.length : close + 1;
    } else if (char === "$" && (next === "{" || next === "(")) {
      end = closing(text, at + 1, next, next === "{" ? "}" : ")");
    } else if (char === "$") {
      PARAMETER.lastIndex = at + 1;
      end = at + 1 + (PARAMETER.exec(text)?.[0].length ?? -1);
    }
    if (end > at) {
      read += PART;
      at = end - 1;
    } else {
      read += char;
    }
  }
  return read;
}

/** A character a shell reads as syntax, a glob or a quote. */
const METACHARACTER = /[|&;<>()"'`*?[\]{}~\\]/gu;

/** An operator, which ends a shell word wherever it stands outside quotes. */
const OPERATOR = /[;&|<>()]+/u;

/**
 * The texts one token stands for as one shell word, an assignment's value for an assignment,
 * or `undefined` where it is not one.
 */
function tokenTexts(token: string): readonly string[] | undefined {
  const script = parse(token);
  const [statement, ...more] = script.commands;
  const command = statement?.command;
  if ((script.errors ?? []).length > 0 || more.length > 0 || command?.type !== "Command") {
    return undefined;
  }
  const [assignment, ...others] = command.prefix;
  if (command.name === undefined) {
    return others.length === 0 &&
      command.suffix.length === 0 &&
      assignment?.type === "Assignment" &&
      assignment.value.type === "Word"
      ? heldTextsOf(assignment.value)
      : undefined;
  }
  return command.prefix.length === 0 && command.suffix.length === 0
    ? heldTextsOf(command.name)
    : undefined;
}

/**
 * The texts one blank-separated token of a line that does not parse stands for: each
 * expansion in it a part, then each piece of it between operators as the one word it is,
 * else with its quotes removed, else with each other character a shell reads as syntax a part.
 */
function tokenPieces(token: string): readonly string[] {
  return expansionsAsParts(token)
    .split(OPERATOR)
    .filter((piece) => piece !== "")
    .flatMap(
      (piece) =>
        tokenTexts(piece) ??
        tokenTexts(piece.replaceAll(/["']/gu, "")) ?? [piece.replaceAll(METACHARACTER, PART)],
    );
}

/** A token that ends a simple command, as a `;`, `&`, `|` or parenthesis it ends with does, and one that starts the next. */
const ENDS_COMMAND = /[;&|()]$/u;
const STARTS_COMMAND = /^[;&|()]/u;

/** The reserved words that may stand before a simple command's program word in a line. */
const RESERVED: ReadonlySet<string> = new Set(
  ["if", "then", "else", "elif", "fi", "do", "done", "while", "until"].concat([
    "case",
    "esac",
    "{",
    "}",
    "!",
    "time",
  ]),
);

/** A token that redirects: its descriptor, its operator, and its target where the token writes it. */
const REDIRECT = /^(\d*)(&>>|&>|<<<|<<-|<<|<>|<&|>&|>>|>\||<|>)(.*)$/su;

/**
 * The standard input one redirect token of a line that does not parse gives: a file for `<`
 * or `<>`, written as `target` writes it, and for a here-document, a here-string or a `<&`,
 * text this reading does not take apart.
 */
function tokenStdin(operator: string, target: string): Stdin {
  if (operator !== "<" && operator !== "<>") {
    return UNKNOWN_STDIN;
  }
  const text = target.replace(/[;&|)]+$/u, "").replaceAll(/["']/gu, "");
  return {
    ...NO_STDIN,
    file: { value: text.includes(PART) ? undefined : text, text, written: text },
  };
}

/**
 * {@link fileOperands} of `words`, the tokens `tokens` of a line read without its structure,
 * one simple command from each operator token to the next, past the reserved words it starts
 * with, its redirect tokens read as {@link tokenStdin} reads them, each first word `program`'s.
 * A command after a `|` reads what no row reads, and any other `stdin`, the line's own; a
 * reader of what no word writes there runs a file no word writes.
 */
function commandsOf(
  tokens: readonly string[],
  words: readonly Word[],
  program: boolean,
  stdin: Stdin,
): ReturnType<typeof fileOperands> {
  const places = new Set<number>();
  const lines = new Map<number, string>();
  const replaced = new Map<number, RegExp>();
  const joined: (readonly [number, number])[] = [];
  const texts: string[] = [];
  let unwritten = false;
  let input = false;
  let stdinRead = false;
  for (let from = 0; from < words.length;) {
    let to = from;
    while (to < words.length && !(to > from && STARTS_COMMAND.test(tokens[to] ?? ""))) {
      to += 1;
      if (ENDS_COMMAND.test(tokens[to - 1] ?? "")) {
        break;
      }
    }
    const piped =
      /(?<!\|)\|$/u.test(tokens[from - 1] ?? "") || /^\|(?!\|)/u.test(tokens[from] ?? "");
    let fed = piped ? UNKNOWN_STDIN : stdin;
    const kept: number[] = [];
    let start = from;
    while (start < to && RESERVED.has(tokens[start] ?? "")) {
      start += 1;
    }
    for (let at = start; at < to; at += 1) {
      const [, descriptor, operator = "", rest = ""] = REDIRECT.exec(tokens[at] ?? "") ?? [];
      if (descriptor === undefined) {
        kept.push(at);
        continue;
      }
      const target = rest === "" && at + 1 < to ? (tokens[(at += 1)] ?? "") : rest;
      if ((descriptor === "" || descriptor === "0") && operator.startsWith("<")) {
        fed = tokenStdin(operator, target);
      }
    }
    const one = fileOperands(
      kept.map((at) => words[at] ?? { value: undefined, text: "" }),
      program,
      fed.file,
    );
    const place = (at: number): number => kept[at] ?? to;
    for (const at of one.places) {
      places.add(place(at));
    }
    for (const [at, prefix] of one.lines) {
      lines.set(place(at), prefix);
    }
    for (const [at, pattern] of one.replaced) {
      replaced.set(place(at), pattern);
    }
    joined.push(...one.joined.map(([start, end]) => [place(start), place(end)] as const));
    texts.push(...one.texts);
    unwritten ||=
      one.unwritten ||
      ((one.input || one.stdin) && (fed.unknown || fed.content.length > 0 || fed.piped.length > 0));
    input ||= one.input;
    stdinRead ||= one.stdin;
    from = to;
  }
  return { places, unwritten, lines, input, stdin: stdinRead, replaced, joined, texts };
}

/**
 * The words of one line read without its structure: the whole line, each blank-separated
 * token as {@link tokenPieces} reads it, as written, so the words inside an expansion count,
 * and with each expansion a part, so a blank inside one splits nothing, and the text of each
 * command substitution as a command line. A token may write the file a command runs at the
 * places {@link fileOperands} gives, `program` saying whether the first token is a program word.
 */
function tokenWords(
  line: string,
  program: boolean,
  depth: number,
  into: HeldWord[],
  stdin = NO_STDIN,
): void {
  const read = expressionsAsParts(line);
  into.push({ text: expansionsAsParts(read), runs: false });
  // Past the depth a command line a program runs is read no more.
  const asLine = (text: string, quoted: boolean): void => {
    if (depth > 0) {
      lineWords(text, depth - 1, quoted, into);
    } else {
      into.push(UNWRITTEN);
    }
  };
  for (const inner of substitutions(read)) {
    asLine(inner, true);
  }
  const blanks = (text: string): readonly string[] =>
    text.split(/\s+/u).filter((token) => token !== "");
  for (const token of blanks(read)) {
    for (const text of tokenPieces(token)) {
      into.push({ text, runs: false });
    }
  }
  const tokens = blanks(expansionsAsParts(read));
  const texts = tokens.map((token) => tokenTexts(token) ?? tokenPieces(token));
  const operands = commandsOf(
    tokens,
    texts.map(([only, ...more], at) => ({
      value: more.length === 0 && only !== undefined && !only.includes(PART) ? only : undefined,
      text: tokens[at] ?? "",
      ...(more.length === 0 && only !== undefined ? { written: only } : {}),
    })),
    program,
    stdin,
  );
  const replacedAt = (at: number): readonly string[] =>
    (texts[at] ?? []).map((text) => {
      const replaced = operands.replaced.get(at);
      return replaced === undefined ? text : text.replace(replaced, PART);
    });
  texts.forEach((_, at) => {
    for (const read of replacedAt(at)) {
      const prefix = operands.lines.get(at);
      into.push({ text: read, runs: operands.places.has(at) });
      if (prefix !== undefined) {
        asLine(read.slice(read.startsWith(prefix) ? prefix.length : 0), false);
      }
    }
  });
  for (const [from, to] of operands.joined) {
    asLine(
      texts
        .slice(from, to)
        .flatMap((_, at) => replacedAt(from + at))
        .join(" "),
      false,
    );
  }
  for (const text of operands.texts) {
    asLine(text, false);
  }
  if (operands.unwritten) {
    into.push(UNWRITTEN);
  }
}

/**
 * How a quoted text or a here-document's body is read: `text` as a command line, where it is
 * not known to be one, without the program-word rule of {@link fileOperands}; `line` as one a
 * shell reads, with it; and `read` not again, inside a word already read as a command line.
 */
type Quoted = "text" | "line" | "read";

/**
 * The standard input of each simple command below `node`: its own, as {@link stdinOf} reads
 * it, that of the nearest compound command around it, or `inherited`, what the command that
 * hands the line on reads; each later member of a pipeline reads what the one before writes.
 */
function inputsOf(node: SyntaxNode, inherited: Stdin, into: Map<SyntaxNode, Stdin>): void {
  const own =
    node.type === "Command" || node.type === "Redirected"
      ? stdinOf(node.redirects, inherited)
      : inherited;
  if (node.type === "Command") {
    into.set(node, own);
  }
  if (node.type === "Pipeline") {
    let carried = own;
    for (const member of node.commands) {
      inputsOf(member, carried, into);
      carried = pipedFrom(member, into);
    }
    return;
  }
  forEachChild(node, (child) => {
    inputsOf(child, own, into);
  });
}

/** The simple commands of `script` the command reader's first layer reads: each member of each pipeline of each and-or list. */
function topCommands(script: ParsedScript): ReadonlySet<SyntaxNode> {
  return new Set(
    script.commands.flatMap(({ command }) =>
      (command.type === "AndOr" ? command.commands : [command]).flatMap((one) =>
        one.type === "Pipeline" ? one.commands : [one],
      ),
    ),
  );
}

/**
 * Each word one parsed command line writes, anywhere in its structure, into `into`. A quoted
 * text or a here-document's body may be a command line a program it is handed to runs, so it
 * is read as one in turn. Where {@link fileOperands} says a command hands a word, or words
 * joined by blanks, to a shell, the shell reads them whole with the command's standard input,
 * and where it reads its standard input, that input as {@link Stdin} reads it: a here-document
 * is a command line only for a shell, and code for a runtime. `stdin` is what the line's own
 * standard input carries, and `tests` whether the line is a manifest's script.
 */
function scriptWords(
  script: ParsedScript,
  depth: number,
  quoted: boolean,
  into: HeldWord[],
  stdin: Stdin,
  tests: boolean,
): void {
  const runs = new Set<SyntaxNode>();
  const lines = new Map<SyntaxNode, string>();
  const replaced = new Map<SyntaxNode, RegExp>();
  const handed = new Map<SyntaxNode, Stdin>();
  const inputs = new Map<SyntaxNode, Stdin>();
  inputsOf(script, stdin, inputs);
  const top = tests ? topCommands(script) : new Set<SyntaxNode>();
  const asLine = (text: string, how: Quoted, fed = NO_STDIN): void => {
    if (depth > 0 && (how === "line" || (how === "text" && LINE_SYNTAX.test(text)))) {
      lineWords(text, depth - 1, how === "text", into, fed);
    } else if (how === "line") {
      // Past the depth a command line a program runs is read no more.
      into.push(UNWRITTEN);
    }
  };
  const visit = (node: SyntaxNode, how: Quoted): void => {
    let inner = how;
    switch (node.type) {
      case "Command": {
        const fed = inputs.get(node) ?? NO_STDIN;
        const words = wordsOf(node);
        const operands =
          words.length === 0
            ? undefined
            : fileOperands(words.map(wordOf), !quoted, fed.file, top.has(node));
        words.forEach((word, at) => {
          const pattern = operands?.replaced.get(at);
          if (operands?.places.has(at) === true) {
            runs.add(word);
          }
          const prefix = operands?.lines.get(at);
          if (prefix !== undefined) {
            lines.set(word, prefix);
            handed.set(word, fed);
          }
          if (pattern !== undefined) {
            replaced.set(word, pattern);
          }
        });
        const reads = operands?.input === true || operands?.stdin === true;
        if (operands?.unwritten === true || (reads && fed.unknown)) {
          into.push(UNWRITTEN);
        }
        for (const text of reads ? fed.piped : []) {
          asLine(text, "line");
        }
        for (const text of operands?.input === true ? fed.content : []) {
          asLine(text, "line");
        }
        for (const text of operands?.texts ?? []) {
          asLine(text, "line", fed);
        }
        for (const [from, to] of operands?.joined ?? []) {
          const texts = words.slice(from, to).flatMap((word, at) => {
            const pattern = operands?.replaced.get(from + at);
            return heldTextsOf(word).map((one) =>
              pattern === undefined ? one : one.replace(pattern, PART),
            );
          });
          asLine(texts.join(" "), "line", fed);
        }
        break;
      }
      case "Word": {
        const pattern = replaced.get(node);
        const prefix = lines.get(node);
        for (const one of heldTextsOf(node)) {
          const text = pattern === undefined ? one : one.replace(pattern, PART);
          into.push({ text, runs: runs.has(node) });
          if (prefix !== undefined) {
            asLine(
              text.slice(text.startsWith(prefix) ? prefix.length : 0),
              "line",
              handed.get(node),
            );
          }
        }
        inner = lines.has(node) ? "read" : how;
        break;
      }
      case "SingleQuoted":
      case "AnsiCQuoted":
        asLine(node.value, how);
        break;
      case "DoubleQuoted":
        asLine(node.text.slice(1, -1), how);
        break;
      case "HereDocBody":
        asLine(node.text, how);
        break;
      default:
        break;
    }
    forEachChild(node, (child) => {
      visit(child, inner);
    });
  };
  visit(script, "text");
}

/**
 * Each word of one command line, read twice: as POSIX reads it, and with each
 * {@link BACKSLASH_PATH} read as `/`, as PowerShell and cmd read a path. A line that does not
 * parse is read line by line, and a line of it that does not parse either by {@link tokenWords};
 * `stdin` and `tests` are what {@link scriptWords} takes.
 */
function lineWords(
  source: string,
  depth: number,
  quoted: boolean,
  into: HeldWord[],
  stdin = NO_STDIN,
  tests = false,
): void {
  for (const reading of new Set([source, source.replaceAll(BACKSLASH_PATH, "/")])) {
    const script = parseLine(reading);
    if ((script.errors ?? []).length === 0) {
      scriptWords(script, depth, quoted, into, stdin, tests && reading === source);
      continue;
    }
    for (const line of reading.split(/\r?\n/u)) {
      const one = parseLine(line);
      if ((one.errors ?? []).length === 0) {
        scriptWords(one, depth, quoted, into, stdin, false);
      } else {
        tokenWords(line, !quoted, depth, into, stdin);
      }
    }
  }
}

/**
 * The words of `texts`: each command string's, and each line of each other value's, read by
 * {@link tokenWords} as a quoted text is, with no program word, but for a `uses:` value that
 * references another repository's action.
 */
export function heldWords(texts: readonly HeldText[]): readonly HeldWord[] {
  const found: HeldWord[] = [];
  for (const { text, shell, key, tested } of texts) {
    if (shell) {
      lineWords(text, DEPTH, false, found, NO_STDIN, tested === true);
    } else if (key !== "uses" || !ACTION_REFERENCE.test(text.trim())) {
      for (const line of text.split(/\r?\n/u)) {
        tokenWords(line, false, DEPTH, found);
      }
    }
  }
  return found;
}
