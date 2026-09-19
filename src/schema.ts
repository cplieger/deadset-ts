import { ConfigError } from "./config.ts";

/**
 * How one node of the closed key list is written.
 *
 * - `leaf` is a setting: a scalar, or an array of scalars.
 * - `section` is an object whose member names the key list declares and which
 *   holds no value of its own.
 * - `map` is an object whose member names the key list leaves open, its values
 *   scalars: the severity and provenance objects.
 * - `list` is an array whose entries are objects with declared members.
 * - `object` is one setting written as an object: its member names are declared
 *   and a source supplies the object whole.
 */
export type KeyKind = "leaf" | "section" | "map" | "list" | "object";

/**
 * One node of the closed key list. `members` holds a section's declared members,
 * or a list entry's, and is absent otherwise.
 */
export interface KeyNode {
  readonly kind: KeyKind;
  readonly members?: Readonly<Record<string, KeyNode>>;
}

const leaf: KeyNode = { kind: "leaf" };

/**
 * The closed key list the Contract's configuration schema declares, derived from
 * that schema key by key. A test pins the two equal, so a Contract change that
 * adds a key fails there rather than being silently unimplemented.
 */
export const SCHEMA_ROOT: KeyNode = {
  kind: "section",
  members: {
    contract_version: leaf,
    target: { kind: "section", members: { kind: leaf } },
    analysis: {
      kind: "section",
      members: {
        languages: leaf,
        min_confidence: leaf,
        generated_files: leaf,
        consumer_tests: leaf,
        configurations: {
          kind: "list",
          members: { id: leaf, os: leaf, arch: leaf, tags: leaf },
        },
        matrix: { kind: "section", members: { complete: leaf } },
        template_dirs: leaf,
        template_delimiters: {
          kind: "object",
          members: { left: leaf, right: leaf },
        },
      },
    },
    consumers: { kind: "section", members: { complete: leaf } },
    roots: { kind: "section", members: { patterns: leaf } },
    severity: { kind: "map" },
    exemptions: { kind: "section", members: { disabled: leaf } },
    reporters: {
      kind: "section",
      members: {
        formats: leaf,
        sort: leaf,
        cascade: leaf,
        max_findings: leaf,
        fail_on: leaf,
      },
    },
    go: { kind: "section", members: {} },
    ts: { kind: "section", members: { test_files: leaf, entry_files: leaf } },
    provenance: { kind: "map" },
  },
};

/** The name of the severity object, whose member names the key list leaves open. */
export const SEVERITY_SECTION = "severity";

/**
 * The node one member name resolves to, and whether the key list declares it. A
 * member of an open object, and any member below a setting, resolves to a leaf,
 * so the walk descends far enough to find a repeated member at any depth.
 */
function memberOf(node: KeyNode, name: string): KeyNode | undefined {
  if (node.kind === "section" || node.kind === "list" || node.kind === "object") {
    const members = node.members ?? {};
    return Object.hasOwn(members, name) ? members[name] : undefined;
  }
  return leaf;
}

function joinKey(at: string, name: string): string {
  return at === "" ? name : `${at}.${name}`;
}

function collect(node: KeyNode, at: string, keys: string[], settingsOnly: boolean): void {
  for (const [name, child] of Object.entries(node.members ?? {})) {
    const path = joinKey(at, name);
    if (!settingsOnly) {
      keys.push(path);
      collect(child, child.kind === "list" ? `${path}[]` : path, keys, settingsOnly);
      continue;
    }
    if (child.kind === "leaf" || child.kind === "list" || child.kind === "object") {
      keys.push(path);
      continue;
    }
    collect(child, path, keys, settingsOnly);
  }
}

/**
 * Every key the closed key list declares, as a dotted path, in ascending order:
 * the sections, the settings, and the two open objects. A list's entry members
 * are spelled under the list's own path followed by empty brackets.
 */
export function declaredKeys(): string[] {
  const keys: string[] = [];
  collect(SCHEMA_ROOT, "", keys, false);
  return keys.sort();
}

/**
 * The dotted path of every setting that holds one value, in ascending order. A
 * list and a setting written as an object are each one setting, their members not
 * addressable on their own, and the severity object is not among them: it
 * resolves per code.
 */
export function settingPaths(): string[] {
  const paths: string[] = [];
  collect(SCHEMA_ROOT, "", paths, true);
  return paths.sort();
}

/**
 * Whether one dotted path names a setting a source may supply: a setting of the
 * closed key list, or one code of the severity object, whose member names the key
 * list leaves open. It is the predicate the command maps its own flag names
 * through, so a flag that would be refused as an unimplemented key is a failing
 * test rather than a flag nothing reads.
 *
 * A section holds no value of its own, so `analysis` is false. A setting written
 * as an object is supplied whole, so `analysis.template_delimiters` is true and
 * `analysis.template_delimiters.left` is false. A severity code is a declared
 * setting whatever it names, so `severity.DS9999` is true here and refused by
 * resolution: this answers the shape of a path, and resolution answers the
 * vocabulary.
 */
export function declaresSetting(path: string): boolean {
  if (settingPaths().includes(path)) {
    return true;
  }
  const dot = path.indexOf(".");
  if (dot < 0) {
    return false;
  }
  const code = path.slice(dot + 1);
  return path.slice(0, dot) === SEVERITY_SECTION && code !== "" && !code.includes(".");
}

/** The Levenshtein distance between two strings, counted in code points. */
function editDistance(a: string, b: string): number {
  const from = Array.from(a);
  const to = Array.from(b);
  let previous = Array.from({ length: to.length + 1 }, (_unused, index) => index);
  let current = new Array<number>(to.length + 1).fill(0);
  for (let i = 1; i <= from.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= to.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (from[i - 1] === to[j - 1] ? 0 : 1);
      current[j] = Math.min(substitution, (previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1);
    }
    [previous, current] = [current, previous];
  }
  return previous[to.length] ?? 0;
}

function sharedSegments(a: readonly string[], b: readonly string[]): number {
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) {
    shared += 1;
  }
  return shared;
}

/**
 * The implemented key closest to `key`: the one sharing the most leading dotted
 * segments, and among those the smallest edit distance over the whole path, ties
 * broken in ascending order.
 */
export function nearestKey(key: string): string {
  const segments = key.split(".");
  let nearest = "";
  let bestShared = -1;
  let bestDistance = 0;
  for (const candidate of declaredKeys()) {
    const shared = sharedSegments(segments, candidate.split("."));
    const distance = editDistance(key, candidate);
    if (shared < bestShared || (shared === bestShared && distance >= bestDistance)) {
      continue;
    }
    nearest = candidate;
    bestShared = shared;
    bestDistance = distance;
  }
  return nearest;
}

/** A refusal of a document that is not one instance of the closed key list. */
export function malformed(label: string, path: string, detail: string): ConfigError {
  const message = path === "" ? `${label}: ${detail}` : `${label}: ${path}: ${detail}`;
  return new ConfigError("malformed", path, message);
}

/**
 * A refusal of a key the closed key list does not declare, naming the nearest key
 * it does.
 */
export function unimplementedKey(label: string, path: string): ConfigError {
  const nearest = nearestKey(path);
  let hint = "";
  if (nearest === path) {
    hint = `; ${JSON.stringify(path)} is one setting written as nested objects, not as one key`;
  } else if (nearest !== "") {
    hint = `; the nearest implemented key is ${JSON.stringify(nearest)}`;
  }
  return new ConfigError(
    "unimplemented-key",
    path,
    `${label}: key ${JSON.stringify(path)} is not implemented${hint}`,
  );
}

/**
 * The position a walk over one document's text has reached. The walk exists
 * because the value a JSON parse returns cannot answer one question the Contract
 * asks: a member written twice at one level is a refusal, and a parse keeps the
 * last value, so the document reads as though it named the member once. Nothing
 * here produces a value; the value is the parse's.
 */
interface Cursor {
  readonly text: string;
  at: number;
}

const SPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);

function skipSpace(cursor: Cursor): void {
  while (cursor.at < cursor.text.length && SPACE.has(cursor.text.charCodeAt(cursor.at))) {
    cursor.at += 1;
  }
}

/**
 * The string literal at the cursor, decoded by the standard library: the walk
 * finds the literal's extent and the parse reads it, so an escaped member name
 * compares equal to the name it spells.
 */
function readName(cursor: Cursor, at: string, label: string): string {
  const start = cursor.at;
  cursor.at += 1;
  while (cursor.at < cursor.text.length) {
    const ch = cursor.text.charCodeAt(cursor.at);
    if (ch === 0x5c) {
      cursor.at += 2;
      continue;
    }
    cursor.at += 1;
    if (ch === 0x22) {
      return JSON.parse(cursor.text.slice(start, cursor.at)) as string;
    }
  }
  throw malformed(label, at, "a member name is not terminated");
}

function skipScalar(cursor: Cursor): void {
  while (cursor.at < cursor.text.length) {
    const ch = cursor.text.charCodeAt(cursor.at);
    if (ch === 0x2c || ch === 0x7d || ch === 0x5d || SPACE.has(ch)) {
      return;
    }
    cursor.at += 1;
  }
}

function walkValue(cursor: Cursor, at: string, node: KeyNode, label: string): void {
  skipSpace(cursor);
  const ch = cursor.text.charCodeAt(cursor.at);
  if (ch === 0x7b) {
    cursor.at += 1;
    walkObject(cursor, at, node, label);
    return;
  }
  if (ch === 0x5b) {
    cursor.at += 1;
    walkArray(cursor, at, node, label);
    return;
  }
  if (ch === 0x22) {
    readName(cursor, at, label);
    return;
  }
  skipScalar(cursor);
}

function walkObject(cursor: Cursor, at: string, node: KeyNode, label: string): void {
  const seen = new Set<string>();
  for (;;) {
    skipSpace(cursor);
    const ch = cursor.text.charCodeAt(cursor.at);
    if (ch === 0x7d) {
      cursor.at += 1;
      return;
    }
    if (ch === 0x2c) {
      cursor.at += 1;
      continue;
    }
    if (ch !== 0x22) {
      throw malformed(label, at, "a member name is expected");
    }
    const name = readName(cursor, at, label);
    const path = joinKey(at, name);
    if (seen.has(name)) {
      throw malformed(
        label,
        path,
        `member ${JSON.stringify(name)} is written twice, so neither value is chosen`,
      );
    }
    seen.add(name);
    const child = memberOf(node, name);
    if (child === undefined) {
      throw unimplementedKey(label, path);
    }
    skipSpace(cursor);
    if (cursor.text.charCodeAt(cursor.at) !== 0x3a) {
      throw malformed(label, path, "a member name is followed by a colon");
    }
    cursor.at += 1;
    walkValue(cursor, path, child, label);
  }
}

function walkArray(cursor: Cursor, at: string, node: KeyNode, label: string): void {
  const entry: KeyNode =
    node.kind === "list" ? { kind: "section", members: node.members ?? {} } : leaf;
  let index = 0;
  for (;;) {
    skipSpace(cursor);
    const ch = cursor.text.charCodeAt(cursor.at);
    if (ch === 0x5d) {
      cursor.at += 1;
      return;
    }
    if (ch === 0x2c) {
      cursor.at += 1;
      continue;
    }
    walkValue(cursor, `${at}[${index}]`, entry, label);
    index += 1;
  }
}

/**
 * Walks one document's text against the closed key list, refusing a member the
 * key list does not declare and a member one object writes twice, each naming its
 * dotted path. The document is already known to parse.
 */
export function checkDocument(text: string, node: KeyNode, label: string): void {
  const cursor: Cursor = { text, at: 0 };
  walkValue(cursor, "", node, label);
}

/**
 * The flag document, whose keys are dotted setting paths, rewritten as the nested
 * object the closed key list declares, so one decoder reads every source. A key
 * naming no setting is refused.
 */
export function nestFlags(flat: Readonly<Record<string, unknown>>, label: string): unknown {
  const nested: Record<string, unknown> = {};
  for (const path of Object.keys(flat).sort()) {
    if (!declaresSetting(path)) {
      throw unimplementedKey(label, path);
    }
    const segments = path.split(".");
    let into = nested;
    for (const segment of segments.slice(0, -1)) {
      const child = into[segment] ?? {};
      if (typeof child !== "object" || Array.isArray(child)) {
        throw malformed(label, path, `the flag document sets ${JSON.stringify(segment)} twice`);
      }
      into[segment] = child;
      into = child as Record<string, unknown>;
    }
    const last = segments[segments.length - 1] ?? "";
    into[last] = flat[path];
  }
  return nested;
}
