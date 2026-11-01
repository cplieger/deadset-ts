/**
 * Layer 1 of the command reader: one command line, parsed by the vendored shell parser, as
 * its and-or lists, their pipelines and the words of each simple command. Nothing here
 * tokenizes, unquotes or splits text.
 */

import {
  parse,
  type CommandNode,
  type PipelineNode,
  type Word as ShellWord,
  type WordPart,
} from "../vendor/unbash/parser.ts";

/** One word of a simple command: its value, or `undefined` where the shell computes it. */
export interface Word {
  readonly value: string | undefined;
  /** The word as the line writes it. */
  readonly text: string;
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

/** Whether one part of a word has a value the line states: a literal, quoted or escaped text. */
function isStatic(part: WordPart): boolean {
  switch (part.type) {
    case "Literal":
    case "SingleQuoted":
    case "AnsiCQuoted":
      return true;
    case "DoubleQuoted":
      return part.parts.every((child) => child.type === "Literal");
    default:
      return false;
  }
}

/**
 * One word as layer 1 reads it. A tilde that starts the word unquoted is the parser's literal
 * text but the shell's home directory, so it makes the word dynamic too.
 */
function wordOf(word: ShellWord): Word {
  const [first] = word.parts ?? [];
  const lead = word.parts === undefined ? word.text : first?.type === "Literal" ? first.text : "";
  const known = (word.parts ?? []).every(isStatic) && !lead.startsWith("~");
  return { value: known ? word.value : undefined, text: word.text };
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
  const script = parse(source);
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
