/**
 * Whether a version satisfies a dependency range, under the grammar npm, pnpm and yarn
 * share: `||` alternatives of hyphen ranges or comparator runs, `x` and missing parts
 * standing for any value, and a prerelease admitted only where a comparator names one
 * of the same version. A range this grammar does not read is satisfied by nothing.
 */

/** A version: three numbers and the prerelease identifiers, build metadata dropped. */
interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
}

/** One comparison a version must pass. */
interface Comparator {
  readonly operator: "<" | "<=" | ">" | ">=" | "=";
  readonly version: Version;
}

/** A version whose parts may be missing or a wildcard, as a range writes one. */
interface Partial {
  readonly major?: number | undefined;
  readonly minor?: number | undefined;
  readonly patch?: number | undefined;
  readonly prerelease: readonly string[];
}

const NUMBER = /^(?:0|[1-9]\d*)$/u;
const IDENTIFIER = /^[0-9A-Za-z-]+$/u;
const WILDCARD = new Set(["x", "X", "*"]);

/** The prerelease identifiers after a hyphen, or `undefined` where one is malformed. */
function prereleaseOf(text: string | undefined): readonly string[] | undefined {
  if (text === undefined) {
    return [];
  }
  const parts = text.split(".");
  return parts.every((part) => IDENTIFIER.test(part)) ? parts : undefined;
}

/**
 * One version as a range writes it, a leading `v` or `=` allowed, or `undefined`
 * where it is not one.
 */
function partialOf(text: string): Partial | undefined {
  const match =
    /^[v=]?([^.+-]+)(?:\.([^.+-]+)(?:\.([^.+-]+)(?:-([^+]+))?)?)?(?:\+[0-9A-Za-z.-]+)?$/u.exec(
      text,
    );
  if (match === null) {
    return undefined;
  }
  const parts: (number | undefined)[] = [];
  let wild = false;
  for (const part of [match[1], match[2], match[3]]) {
    if (part === undefined || WILDCARD.has(part)) {
      wild = true;
      parts.push(undefined);
      continue;
    }
    if (wild || !NUMBER.test(part)) {
      return undefined;
    }
    parts.push(Number(part));
  }
  const prerelease = prereleaseOf(match[4]);
  if (prerelease === undefined || (prerelease.length > 0 && wild)) {
    return undefined;
  }
  return { major: parts[0], minor: parts[1], patch: parts[2], prerelease };
}

/** One exact version, or `undefined` where the text is not one. */
function versionOf(text: string): Version | undefined {
  const partial = partialOf(text.trim());
  if (partial?.major === undefined || partial.minor === undefined || partial.patch === undefined) {
    return undefined;
  }
  return {
    major: partial.major,
    minor: partial.minor,
    patch: partial.patch,
    prerelease: partial.prerelease,
  };
}

function exact(
  major: number,
  minor: number,
  patch: number,
  prerelease: readonly string[] = [],
): Version {
  return { major, minor, patch, prerelease };
}

/** The lowest prerelease of one version, which bounds a range from above. */
function floorOf(major: number, minor: number, patch: number): Version {
  return exact(major, minor, patch, ["0"]);
}

function compareIdentifiers(a: string, b: string): number {
  const numericA = NUMBER.test(a);
  const numericB = NUMBER.test(b);
  if (numericA && numericB) {
    return Math.sign(Number(a) - Number(b));
  }
  if (numericA !== numericB) {
    return numericA ? -1 : 1;
  }
  return a === b ? 0 : a < b ? -1 : 1;
}

/** Two versions ordered by precedence. */
function compare(a: Version, b: Version): number {
  const core =
    Math.sign(a.major - b.major) || Math.sign(a.minor - b.minor) || Math.sign(a.patch - b.patch);
  if (core !== 0) {
    return core;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return Math.sign(b.prerelease.length - a.prerelease.length);
  }
  for (let at = 0; at < Math.max(a.prerelease.length, b.prerelease.length); at += 1) {
    const left = a.prerelease[at];
    const right = b.prerelease[at];
    if (left === undefined || right === undefined) {
      return left === undefined ? -1 : 1;
    }
    const order = compareIdentifiers(left, right);
    if (order !== 0) {
      return order;
    }
  }
  return 0;
}

function passes(version: Version, comparator: Comparator): boolean {
  const order = compare(version, comparator.version);
  switch (comparator.operator) {
    case "<":
      return order < 0;
    case "<=":
      return order <= 0;
    case ">":
      return order > 0;
    case ">=":
      return order >= 0;
    case "=":
      return order === 0;
  }
}

/** The comparators a version with missing parts stands for: any value of each. */
function anyOf(partial: Partial): Comparator[] {
  const { major, minor } = partial;
  if (major === undefined) {
    return [{ operator: ">=", version: exact(0, 0, 0) }];
  }
  if (minor === undefined) {
    return [
      { operator: ">=", version: exact(major, 0, 0) },
      { operator: "<", version: floorOf(major + 1, 0, 0) },
    ];
  }
  if (partial.patch === undefined) {
    return [
      { operator: ">=", version: exact(major, minor, 0) },
      { operator: "<", version: floorOf(major, minor + 1, 0) },
    ];
  }
  return [{ operator: "=", version: exact(major, minor, partial.patch, partial.prerelease) }];
}

/** The lowest version a partial version stands for. */
function lowest(partial: Partial): Version {
  return exact(partial.major ?? 0, partial.minor ?? 0, partial.patch ?? 0, partial.prerelease);
}

function tilde(partial: Partial): Comparator[] {
  const { major, minor } = partial;
  if (major === undefined || minor === undefined) {
    return anyOf(partial);
  }
  return [
    { operator: ">=", version: lowest(partial) },
    { operator: "<", version: floorOf(major, minor + 1, 0) },
  ];
}

function caret(partial: Partial): Comparator[] {
  const { major, minor, patch } = partial;
  if (major === undefined) {
    return anyOf(partial);
  }
  const from = { operator: ">=" as const, version: lowest(partial) };
  if (major > 0 || minor === undefined) {
    return [from, { operator: "<", version: floorOf(major + 1, 0, 0) }];
  }
  if (minor > 0 || patch === undefined) {
    return [from, { operator: "<", version: floorOf(0, minor + 1, 0) }];
  }
  return [from, { operator: "<", version: floorOf(0, 0, patch + 1) }];
}

/** The comparators one primitive comparison stands for, a partial version filled in. */
function primitive(operator: "<" | "<=" | ">" | ">=", partial: Partial): Comparator[] {
  const { major, minor, patch } = partial;
  if (major === undefined) {
    return operator === "<" || operator === ">"
      ? [{ operator: "<", version: floorOf(0, 0, 0) }]
      : [{ operator: ">=", version: exact(0, 0, 0) }];
  }
  if (minor !== undefined && patch !== undefined) {
    return [{ operator, version: lowest(partial) }];
  }
  const next = minor === undefined ? exact(major + 1, 0, 0) : exact(major, minor + 1, 0);
  switch (operator) {
    case ">":
      return [{ operator: ">=", version: next }];
    case ">=":
      return [{ operator: ">=", version: lowest(partial) }];
    case "<":
      return [{ operator: "<", version: floorOf(major, minor ?? 0, 0) }];
    case "<=":
      return [{ operator: "<", version: floorOf(next.major, next.minor, 0) }];
  }
}

/** The comparators one written comparator stands for, or `undefined` where it is none. */
function comparatorsOf(token: string): Comparator[] | undefined {
  const match = /^(<=|>=|<|>|=|~>|~|\^)?(.*)$/u.exec(token);
  const operator = match?.[1] ?? "";
  const partial = partialOf(match?.[2] ?? "");
  if (partial === undefined) {
    return undefined;
  }
  switch (operator) {
    case "~":
    case "~>":
      return tilde(partial);
    case "^":
      return caret(partial);
    case "<":
    case "<=":
    case ">":
    case ">=":
      return primitive(operator, partial);
    default:
      return anyOf(partial);
  }
}

/** The comparators of one alternative, or `undefined` where it does not read. */
function alternativeOf(text: string): Comparator[] | undefined {
  const spaced = text.trim().replaceAll(/(<=|>=|<|>|=|~>|~|\^)\s+/gu, "$1");
  if (spaced === "") {
    return anyOf({ prerelease: [] });
  }
  const hyphen = /^(\S+)\s+-\s+(\S+)$/u.exec(spaced);
  if (hyphen !== null) {
    const from = partialOf(hyphen[1] ?? "");
    const to = partialOf(hyphen[2] ?? "");
    if (from === undefined || to === undefined) {
      return undefined;
    }
    return [...primitive(">=", from), ...(to.major === undefined ? [] : primitive("<=", to))];
  }
  const found: Comparator[] = [];
  for (const token of spaced.split(/\s+/u)) {
    const comparators = comparatorsOf(token);
    if (comparators === undefined) {
      return undefined;
    }
    found.push(...comparators);
  }
  return found;
}

/** Whether one alternative admits one version, its prerelease rule included. */
function admits(alternative: readonly Comparator[], version: Version): boolean {
  if (!alternative.every((comparator) => passes(version, comparator))) {
    return false;
  }
  if (version.prerelease.length === 0) {
    return true;
  }
  return alternative.some(
    ({ version: bound }) =>
      bound.prerelease.length > 0 &&
      bound.major === version.major &&
      bound.minor === version.minor &&
      bound.patch === version.patch,
  );
}

/** Whether `version` satisfies `range`; `false` where either does not read. */
export function satisfies(version: string, range: string): boolean {
  const parsed = versionOf(version);
  if (parsed === undefined) {
    return false;
  }
  const alternatives = range.split("||").map(alternativeOf);
  return (
    alternatives.every((alternative) => alternative !== undefined) &&
    alternatives.some((alternative) => admits(alternative, parsed))
  );
}
