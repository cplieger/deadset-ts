/**
 * Layer 1 of the command reader: one command line, parsed by the vendored shell parser, as
 * its and-or lists, their pipelines and the words of each simple command, and the one place
 * that decides which parts of a word the shell computes and which words a brace expansion
 * stands for, for layer 3 too.
 */

import {
  parse,
  type CommandNode,
  type ParsedScript,
  type PipelineNode,
  type Word as ShellWord,
  type WordPart,
} from "../vendor/unbash/parser.ts";

/**
 * The character that stands, in a word's text as layer 3 reads it, for a part only the run
 * knows. It is a private-use character, so no path holds it, and the parser reads it as
 * literal text.
 */
export const PART = "\uE000";

/** A GitHub Actions expression, which the runner substitutes before any shell reads the line. */
const EXPRESSION = /\$\{\{[\s\S]*?\}\}/gu;

/** `text` with each `${{ }}` expression in it read as a part only the run knows. */
export function expressionsAsParts(text: string): string {
  return text.replace(EXPRESSION, PART);
}

/** One command line parsed, each `${{ }}` expression in it read as a part only the run knows. */
export function parseLine(source: string): ParsedScript {
  return parse(expressionsAsParts(source));
}

/** The words a word's brace expansions stand for, at most this many. */
const ALTERNATIVES = 64;

/** One word of a simple command: its value, or `undefined` where the shell computes it. */
export interface Word {
  readonly value: string | undefined;
  /** The word as the line writes it. */
  readonly text: string;
  /** Where the shell expands it to one text, that text with each part it computes as {@link PART}. */
  readonly written?: string;
}

/** One pipeline of an and-or list. */
export interface Pipeline {
  /** The operator that joins it to the pipeline before it, `undefined` for a list's first. */
  readonly operator: "&&" | "||" | undefined;
  /** Whether a `!` inverts its status. */
  readonly negated: boolean;
  /** The words of each member that is a simple command with a program word. */
  readonly commands: readonly (readonly Word[])[];
  /**
   * Whether it has one member, which runs in the line's own shell; with several, each member
   * runs in a subshell of its own, whatever it is.
   */
  readonly alone: boolean;
  /**
   * Whether its one member is no simple command but a compound command, whose commands may
   * change the line's shell's directory, or a function definition, whose later calls may.
   */
  readonly opaque: boolean;
}

/** One and-or list: its pipelines, run in a subshell where `&` sends it to the background. */
interface List {
  readonly background: boolean;
  readonly pipelines: readonly Pipeline[];
}

/**
 * The text one part of a word stands for: a literal's, a quoted text's or an escape's value,
 * and {@link PART} for every part the shell computes, a glob among them.
 */
function partText(part: WordPart): string {
  switch (part.type) {
    case "Literal":
    case "SingleQuoted":
    case "AnsiCQuoted":
      return part.value;
    case "DoubleQuoted":
      return part.parts.map((child) => (child.type === "Literal" ? child.value : PART)).join("");
    default:
      return PART;
  }
}

/** The texts the word `piece` of a brace expansion stands for, or a part where it is no one word. */
function alternativeTexts(piece: string): readonly string[] {
  if (piece === "") {
    return [""];
  }
  const script = parse(piece);
  const [statement, ...more] = script.commands;
  const command = statement?.command;
  return (script.errors ?? []).length === 0 &&
    more.length === 0 &&
    command?.type === "Command" &&
    command.name !== undefined &&
    command.prefix.length === 0 &&
    command.suffix.length === 0
    ? heldTextsOf(command.name)
    : [PART];
}

/**
 * The texts a brace expansion stands for, its comma-separated alternatives, or a part where it
 * has none, a sequence such as `{1..3}` among them.
 */
function braceTexts(text: string): readonly string[] {
  const inner = text.slice(1, -1);
  const pieces: string[] = [];
  let depth = 0;
  let from = 0;
  let quote = "";
  for (let at = 0; at < inner.length; at += 1) {
    const char = inner.charAt(at);
    if (char === "\\") {
      at += 1;
    } else if (quote !== "") {
      quote = char === quote ? "" : quote;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === "{" || char === "}") {
      depth += char === "{" ? 1 : -1;
    } else if (char === "," && depth === 0) {
      pieces.push(inner.slice(from, at));
      from = at + 1;
    }
  }
  if (pieces.length === 0) {
    return [PART];
  }
  pieces.push(inner.slice(from));
  return pieces.flatMap(alternativeTexts);
}

/**
 * Each word the shell may expand `word` to, as layer 3 reads it: its quotes removed, each brace
 * expansion read as its alternatives, past {@link ALTERNATIVES} words as a part, and each part
 * it computes, a tilde that starts it unquoted among them, as {@link PART}.
 */
export function heldTextsOf(word: ShellWord): readonly string[] {
  const { parts } = word;
  const [first] = parts ?? [];
  const tilde =
    parts === undefined
      ? word.text.startsWith("~")
      : first?.type === "Literal" && first.text.startsWith("~");
  let texts: readonly string[] = [parts === undefined ? word.value : ""];
  for (const part of parts ?? []) {
    const options = part.type === "BraceExpansion" ? braceTexts(part.text) : [partText(part)];
    const next = texts.flatMap((text) => options.map((option) => `${text}${option}`));
    texts = next.length > ALTERNATIVES ? texts.map((text) => `${text}${PART}`) : next;
  }
  return tilde ? texts.map((text) => `${PART}${text.slice(1)}`) : texts;
}

/** One word as layer 1 reads it: static only where the shell expands it to one text with no part. */
export function wordOf(word: ShellWord): Word {
  const [only, ...more] = heldTextsOf(word);
  const one = more.length === 0 ? only : undefined;
  const known = one !== undefined && !one.includes(PART);
  return {
    value: known ? word.value : undefined,
    text: word.text,
    ...(one === undefined ? {} : { written: one }),
  };
}

/**
 * Whether one member of a pipeline, run in the line's own shell, may change that shell's
 * directory without being a simple command: POSIX XCU 2.9.4 runs every compound command but
 * `( )` in the current environment, and a function body runs there when called.
 */
function isOpaque(node: CommandNode): boolean {
  switch (node.type) {
    case "Command":
    case "Subshell":
    case "Coproc":
    case "TestCommand":
    case "ArithmeticCommand":
      return false;
    case "Redirected":
      return isOpaque(node.command);
    default:
      return true;
  }
}

function pipelineOf(node: PipelineNode, operator: Pipeline["operator"]): Pipeline {
  const members = node.type === "Pipeline" ? node.commands : [node];
  const negated =
    node.type === "Pipeline" && node.prefixes.some((prefix) => prefix.type === "Negation");
  const commands = members.flatMap((member) =>
    member.type === "Command" && member.name !== undefined
      ? [[member.name, ...member.suffix.filter((part) => part.type === "Word")].map(wordOf)]
      : [],
  );
  const alone = members.length === 1;
  return { operator, negated, commands, alone, opaque: alone && members.some(isOpaque) };
}

/**
 * The and-or lists one command line runs, or none where any of it does not parse. A simple
 * command's assignments and redirections are no words; a part that is no simple command
 * gives no words, and marks its pipeline where it may change the line's directory.
 */
export function shellLine(source: string): readonly List[] {
  const script = parseLine(source);
  if ((script.errors ?? []).length > 0) {
    return [];
  }
  return script.commands.map((statement) => {
    const { command } = statement;
    const pipelines =
      command.type === "AndOr"
        ? command.commands.map((one, at) =>
            pipelineOf(one, at === 0 ? undefined : command.operators[at - 1]),
          )
        : [pipelineOf(command, undefined)];
    return { background: statement.background === true, pipelines };
  });
}
