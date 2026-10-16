/**
 * Shell command lines read as text, never run: the commands a line runs, the tokens the
 * Contract splits a command into, and the words POSIX token recognition reads.
 */

/**
 * The shell's list and pipeline operators, each of which ends one command. An `&` beside a
 * redirection's `<` or `>` (`2>&1`, and bash's `&>log`) is part of the redirection.
 */
const COMMAND_OPERATORS = /&&|\|\||;|\||(?<![<>])&(?!>)/u;

/** Where a command splits into tokens: white space and the operators the Contract names. */
const TOKEN_SEPARATORS = /\s+|&&|\|\||;|\|/u;

/** A text written inside one pair of quotes. */
const QUOTED = /^(["'])(.*)\1$/su;

/** The commands one line runs, the text between two of the shell's list and pipeline operators. */
export function commandsOf(line: string): readonly string[] {
  return line.split(COMMAND_OPERATORS);
}

/** One text with one pair of enclosing quotes removed. */
export function unquoted(text: string): string {
  return text.replace(QUOTED, "$2");
}

/**
 * Every token one script's command line holds, each with one pair of enclosing quotes
 * removed. A token holding a wildcard is a pattern rather than a path, and names no
 * entry point.
 */
export function scriptTokens(command: string): readonly string[] {
  return command
    .split(TOKEN_SEPARATORS)
    .map(unquoted)
    .filter((token) => token !== "" && !token.includes("*"));
}

/** One shell line up to its comment: a `#` that starts a word outside quotes. */
export function withoutComment(line: string): string {
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

/** The characters that end a word outside quotes and separate nothing: blanks. */
// Stryker disable next-line Regex: its \v to \V mutant is no valid escape under the u flag, so the whole module fails to parse
const BLANK = /[ \t\r\f\v]/u;

/** The characters that end a word outside quotes and begin an operator: newline included. */
const OPERATOR = /[\n;&|()<>]/u;

/** The characters a backslash escapes inside double quotes; before any other it stands for itself. */
const DOUBLE_QUOTE_ESCAPES = new Set(["$", "`", '"', "\\"]);

/**
 * The words of one command line, as POSIX token recognition reads quotes, backslashes,
 * line continuations, comments and operators. A word an expansion may change (an unquoted
 * `$`, backquote, glob character or leading `~`, or a `$` or backquote in double quotes)
 * is computed, and so is the rest of a line whose quote is never closed. A computed word
 * and each operator are undefined, so a flag's file is never read across them.
 */
export function shellWords(command: string): readonly (string | undefined)[] {
  const words: (string | undefined)[] = [];
  let word: string | undefined;
  let computed = false;
  const end = (): void => {
    if (word !== undefined) {
      words.push(computed ? undefined : word);
    }
    word = undefined;
    computed = false;
  };
  for (let at = 0; at < command.length; at += 1) {
    const char = command.charAt(at);
    if (char === "\\" && command.charAt(at + 1) === "\n") {
      at += 1;
    } else if (BLANK.test(char)) {
      end();
    } else if (OPERATOR.test(char)) {
      end();
      words.push(undefined);
    } else if (char === "#" && word === undefined) {
      const newline = command.indexOf("\n", at);
      at = newline < 0 ? command.length : newline - 1;
    } else if (char === "\\") {
      at += 1;
      word = (word ?? "") + command.charAt(at);
    } else if (char === "'" || char === '"') {
      const close = closingQuote(command, at);
      if (close < 0) {
        word ??= "";
        computed = true;
        break;
      }
      const quoted =
        char === "'"
          ? { text: command.slice(at + 1, close), computed: false }
          : doubleQuoted(command.slice(at + 1, close));
      word = (word ?? "") + quoted.text;
      computed ||= quoted.computed;
      at = close;
    } else {
      computed ||= /[$`*?[]/u.test(char) || (char === "~" && word === undefined);
      word = (word ?? "") + char;
    }
  }
  end();
  return words;
}

/** The text between one pair of double quotes, unescaped, and whether an expansion may change it. */
function doubleQuoted(inner: string): { readonly text: string; readonly computed: boolean } {
  let text = "";
  let computed = false;
  for (let at = 0; at < inner.length; at += 1) {
    const char = inner.charAt(at);
    const next = inner.charAt(at + 1);
    if (char === "\\" && next === "\n") {
      at += 1;
    } else if (char === "\\" && DOUBLE_QUOTE_ESCAPES.has(next)) {
      text += next;
      at += 1;
    } else {
      computed ||= char === "$" || char === "`";
      text += char;
    }
  }
  return { text, computed };
}

/** The index of the quote that closes the one at `open`, or -1 where none does. */
function closingQuote(command: string, open: number): number {
  const quote = command.charAt(open);
  for (let at = open + 1; at < command.length; at += 1) {
    const char = command.charAt(at);
    if (char === quote) {
      return at;
    }
    if (quote === '"' && char === "\\") {
      at += 1;
    }
  }
  return -1;
}
