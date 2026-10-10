/**
 * The `packages` list of a `pnpm-workspace.yaml`. The document is read as far as that
 * one key needs and no further: a top-level `packages` key holding a block sequence or
 * a one-line flow sequence of plain or quoted strings. Any other value of the key is
 * refused rather than guessed at, because a list read wrong names the wrong packages.
 */

/** What the document says about `packages`. */
type PnpmPackages =
  | { readonly kind: "listed"; readonly patterns: readonly string[] }
  /** The document declares no `packages` key. */
  | { readonly kind: "absent" }
  /** The key holds something this reader does not read, with what it holds. */
  | { readonly kind: "refused"; readonly reason: string };

/** The characters a plain scalar may not start with. */
const INDICATORS = new Set(["[", "]", "{", "}", ",", "&", "*", "!", "|", ">", "%", "@", "`", "#"]);

/** One line with its comment removed, a `#` inside quotes kept. */
function uncommented(line: string): string {
  let quote: string | undefined;
  for (let at = 0; at < line.length; at += 1) {
    const character = line[at];
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
    } else if (character === "#" && (at === 0 || /\s/u.test(line[at - 1] ?? ""))) {
      return line.slice(0, at).trimEnd();
    }
  }
  return line.trimEnd();
}

/** One scalar as written, or `undefined` where it is not a string this reader reads. */
function scalarOf(text: string): string | undefined {
  const value = text.trim();
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    const inner = value.slice(1, -1);
    return /'(?!')/u.test(inner.replaceAll("''", "")) ? undefined : inner.replaceAll("''", "'");
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    const inner = value.slice(1, -1);
    return inner.includes("\\") || inner.includes('"') ? undefined : inner;
  }
  if (
    value === "" ||
    INDICATORS.has(value[0] ?? "") ||
    value.startsWith("'") ||
    value.startsWith('"')
  ) {
    return undefined;
  }
  if (value.startsWith("- ") || value.startsWith("? ") || /:(?:\s|$)/u.test(value)) {
    return undefined;
  }
  return value;
}

/** The entries of a one-line flow sequence, or `undefined` where one does not read. */
function flowOf(text: string): readonly string[] | undefined {
  const inner = text.slice(1, -1).trim();
  if (inner === "") {
    return [];
  }
  const entries = inner.split(",");
  if (entries.length > 1 && entries.at(-1)?.trim() === "") {
    entries.pop();
  }
  const found: string[] = [];
  for (const entry of entries) {
    const value = scalarOf(entry);
    if (value === undefined) {
      return undefined;
    }
    found.push(value);
  }
  return found;
}

const KEY = /^(?:packages|'packages'|"packages")\s*:(?:\s(.*))?$/u;

/** The `packages` list one `pnpm-workspace.yaml` text declares. */
export function pnpmPackages(text: string): PnpmPackages {
  const lines = text.split(/\r?\n/u).map(uncommented);
  const keys = lines.flatMap((line, at) => (KEY.test(line) ? [at] : []));
  const [at] = keys;
  if (at === undefined) {
    return { kind: "absent" };
  }
  if (keys.length > 1) {
    return { kind: "refused", reason: "the packages key is declared more than once" };
  }
  const rest = (KEY.exec(lines[at] ?? "")?.[1] ?? "").trim();
  if (rest !== "") {
    const listed = rest.startsWith("[") && rest.endsWith("]") ? flowOf(rest) : undefined;
    return listed === undefined
      ? {
          kind: "refused",
          reason: `packages holds ${JSON.stringify(rest)}, not a sequence of strings`,
        }
      : { kind: "listed", patterns: listed };
  }
  const patterns: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === "") {
      continue;
    }
    const item = /^(\s*)-(?:\s+(.*))?$/u.exec(line);
    if (item === null) {
      if (/^\s/u.test(line)) {
        return {
          kind: "refused",
          reason: `packages holds ${JSON.stringify(line.trim())}, not a sequence item`,
        };
      }
      break;
    }
    const value = scalarOf(item[2] ?? "");
    if (value === undefined) {
      return {
        kind: "refused",
        reason: `the packages item ${JSON.stringify(line.trim())} is not a plain or quoted string`,
      };
    }
    patterns.push(value);
  }
  return patterns.length === 0
    ? { kind: "refused", reason: "packages holds no sequence" }
    : { kind: "listed", patterns };
}
