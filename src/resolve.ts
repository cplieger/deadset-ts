import { SETTINGS, type SettingRow } from "./contract/config.generated.ts";
import { FAMILY_KEY_LENGTH } from "./contract/contract.generated.ts";
import {
  type Document,
  type Inputs,
  type Origin,
  type PartialConfig,
  type Provenance,
  type ResolvedConfig,
  type Source,
} from "./config.ts";
import { CONVENTION_ROWS } from "./convention-rows.ts";
import { refuseOverBound } from "./fs/document.ts";
import {
  dotted,
  isRecord,
  locatedFault,
  type Place,
  placeIn,
  pointerOf,
  readStrict,
  StrictJSONError,
} from "./json-document.ts";
import { FIXED_SEVERITY_CODES } from "./kinds.ts";
import { LANGUAGE } from "./product.ts";
import { firstRefusal, type SchemaRefusal } from "./schema.ts";
import { bytewise } from "./text/compare.ts";
import { UsageError } from "./usage.ts";

const ROWS: ReadonlyMap<string, SettingRow> = new Map(SETTINGS.map((row) => [row.key, row]));

/** The schema of a section or a keyed section's value, so the validator words its refusal. */
const OBJECT = { type: "object" };

/**
 * The settings whose entries name rows of this analyzer's own data, which the
 * Contract's schema cannot list: a disabled convention names a convention row.
 */
const OWN_VOCABULARIES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["ts.disabled_conventions", new Set(CONVENTION_ROWS.map((row) => row.name))],
]);

function malformed(label: string, path: string, detail: string): UsageError {
  return new UsageError(path === "" ? `${label}: ${detail}` : `${label}: ${path}: ${detail}`);
}

/** A key the closed key list does not declare, with the reason where there is more to say. */
function unimplemented(label: string, path: string, reason = ""): UsageError {
  const why = reason === "" ? "" : `: ${reason}`;
  return new UsageError(`${label}: key ${JSON.stringify(path)} is not implemented${why}`);
}

/** Why a well-formed severity key the vocabulary does not hold names no setting. */
function severityKeyRefused(key: string): string {
  const fixed = FIXED_SEVERITY_CODES.filter(
    (code) => code === key || (key.length === FAMILY_KEY_LENGTH && code.startsWith(key)),
  ).sort(bytewise);
  if (fixed.length > 0) {
    const named =
      fixed.length < 2
        ? fixed.join("")
        : `${fixed.slice(0, -1).join(", ")} and ${String(fixed.at(-1))}`;
    return `the Contract fixes the severity of ${named}, which this key names`;
  }
  return key.length === FAMILY_KEY_LENGTH
    ? `no issue kind carries a code of the family ${key}`
    : `no issue kind carries the code ${key}`;
}

/** A value with every object's members in ascending order, so it prints one way. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort(bytewise)
      .map((name) => [name, canonical(value[name])]),
  );
}

/** What one checked source supplies: each setting's value and each keyed section's members. */
interface Supplied {
  readonly values: Map<string, unknown>;
  readonly keyed: Map<string, Readonly<Record<string, unknown>>>;
}

/**
 * The walk of one source over the closed key list. The members of an object are checked
 * in ascending order and a key is checked whole before the next. A key this analyzer's
 * language does not read is accepted unread, and of a key written per language, every
 * other language's member.
 */
class Walk {
  private readonly label: string;
  private readonly fractions: ReadonlyMap<string, string>;
  private readonly into: Supplied;

  constructor(label: string, fractions: ReadonlyMap<string, string>, into: Supplied) {
    this.label = label;
    this.fractions = fractions;
    this.into = into;
  }

  section(at: string, members: Readonly<Record<string, unknown>>): void {
    for (const name of Object.keys(members).sort(bytewise)) {
      const key = at === "" ? name : `${at}.${name}`;
      const row = ROWS.get(key);
      if (name.includes(".")) {
        const reason = row === undefined ? "" : "it is one setting, written as nested objects";
        throw unimplemented(this.label, key, reason);
      }
      if (row === undefined) {
        throw unimplemented(this.label, key);
      }
      if (row.read) {
        this.key(row, members[name]);
      }
    }
  }

  private key(row: SettingRow, value: unknown): void {
    if (row.role === "section") {
      this.refuse(row.key.split("."), value, firstRefusal(OBJECT, value));
      this.section(row.key, value as Record<string, unknown>);
    } else if (row.role === "setting") {
      const read = row.perLanguage === undefined ? value : this.narrowed(row, value);
      this.setting(row, read);
      this.into.values.set(row.key, canonical(read));
    } else {
      const members = this.keyed(row, value);
      if (row.role === "keyed") {
        this.into.keyed.set(row.key, members);
      }
    }
  }

  /** A per-language value as this language reads it: of the object form, its own member alone. */
  private narrowed(row: SettingRow, value: unknown): unknown {
    if (!isRecord(value)) {
      return value;
    }
    const others: readonly string[] = row.perLanguage ?? [];
    return Object.fromEntries(
      Object.entries(value).filter(([name]) => name === LANGUAGE || !others.includes(name)),
    );
  }

  private setting(row: SettingRow, value: unknown): void {
    this.refuse(row.key.split("."), value, firstRefusal(row.value ?? {}, value));
    const text = this.fractions.get(pointerOf(row.key.split(".")));
    if (typeof value === "number" && text !== undefined) {
      throw malformed(
        this.label,
        row.key,
        `holds ${text}, want an integer written as an optional minus sign and digits alone`,
      );
    }
    const own = OWN_VOCABULARIES.get(row.key);
    if (own !== undefined) {
      const names = value as readonly string[];
      const unknown = names.findIndex((name) => !own.has(name));
      if (unknown !== -1) {
        throw malformed(
          this.label,
          `${row.key}[${String(unknown)}]`,
          `${JSON.stringify(names[unknown])} names no row this analyzer carries`,
        );
      }
    }
  }

  /** A keyed or an ignored section: an object whose member names its key pattern admits. */
  private keyed(row: SettingRow, value: unknown): Readonly<Record<string, unknown>> {
    this.refuse(row.key.split("."), value, firstRefusal(OBJECT, value));
    const members = value as Readonly<Record<string, unknown>>;
    const shape = new RegExp(row.keyPattern ?? "", "u");
    for (const name of Object.keys(members).sort(bytewise)) {
      const at = `${row.key}.${name}`;
      if (!shape.test(name)) {
        throw unimplemented(this.label, at, `the name does not match ${String(row.keyPattern)}`);
      }
      if (row.values !== undefined && !row.values.includes(name)) {
        throw unimplemented(this.label, at, severityKeyRefused(name));
      }
      const member = members[name];
      this.refuse([...row.key.split("."), name], member, firstRefusal(row.value ?? {}, member));
    }
    return members;
  }

  /** Throws the refusal the schema makes of `value`, at `at`, naming the place inside it. */
  private refuse(at: Place, value: unknown, refused: SchemaRefusal | undefined): void {
    if (refused === undefined) {
      return;
    }
    const place = dotted([...at, ...placeIn(value, refused.pointer, refused.member)]);
    switch (refused.keyword) {
      case "additionalProperties":
        throw unimplemented(this.label, place);
      case "required":
        throw malformed(this.label, place, "is required and absent");
    }
    throw malformed(this.label, place, refused.reason);
  }
}

/** One source a resolution reads, with what it supplies. */
interface Held {
  readonly source: Source;
  readonly label: string;
  readonly supplied: Supplied;
}

const supplies = (): Supplied => ({ values: new Map(), keyed: new Map() });

/** Reads and checks one configuration document. */
function documentSource(source: Source, document: Document): Held {
  const { text, label } = document;
  refuseOverBound(label, text);
  let read;
  try {
    read = readStrict(text);
  } catch (error: unknown) {
    if (!(error instanceof StrictJSONError)) {
      throw error;
    }
    throw malformed(label, dotted(error.place), locatedFault(text, error));
  }
  if (!isRecord(read.value)) {
    throw malformed(label, "", "is not one JSON object");
  }
  const supplied = supplies();
  new Walk(label, read.fractions, supplied).section("", read.value);
  return { source, label, supplied };
}

/** The command line as a source: each flag checked as the one-setting document it supplies. */
function flagSource(flags: ReadonlyMap<string, string>): Held {
  const supplied = supplies();
  for (const key of [...flags.keys()].sort(bytewise)) {
    const row = ROWS.get(key);
    const text = flags.get(key) ?? "";
    if (row?.option === undefined) {
      throw unimplemented("the command line", key, "no flag supplies it");
    }
    const integer = row.value?.["type"] === "integer" && /^-?[0-9]+$/u.test(text);
    let document: unknown = integer ? Number(text) : text;
    for (const name of key.split(".").reverse()) {
      document = { [name]: document };
    }
    new Walk(`--${row.option}`, new Map(), supplied).section(
      "",
      document as Record<string, unknown>,
    );
  }
  return { source: "flag", label: "", supplied };
}

function originOf(held: Held, key: string): Origin {
  const label = held.source === "flag" ? `--${String(ROWS.get(key)?.option)}` : held.label;
  return { source: held.source, label };
}

function searched(named: string, document: Document | undefined): string {
  return `${named} (${document === undefined ? "not present" : document.label})`;
}

/** Sets the value at one dotted key of the resolved tree, whose sections the table lists first. */
function setAt(tree: Record<string, unknown>, key: string, value: unknown): void {
  const names = key.split(".");
  let into = tree;
  for (const name of names.slice(0, -1)) {
    into = into[name] as Record<string, unknown>;
  }
  into[names.at(-1) ?? key] = value;
}

/**
 * Every setting this analyzer reads, each from the highest-ranked source carrying it,
 * else its default, in the closed key list's order. A setting with no default no
 * source supplies is refused where its row is required and `enforce` holds, and left
 * unset otherwise. A keyed section's members overlay its default's, member by member.
 */
function settle(
  inputs: Inputs,
  enforce: boolean,
): { config: PartialConfig; provenance: Provenance } {
  const sources: Held[] = [];
  if (inputs.flags !== undefined && inputs.flags.size > 0) {
    sources.push(flagSource(inputs.flags));
  }
  if (inputs.repository !== undefined) {
    sources.push(documentSource("repository", inputs.repository));
  }
  if (inputs.central !== undefined) {
    sources.push(documentSource("central", inputs.central));
  }
  const tree: Record<string, unknown> = {};
  const provenance = new Map<string, Origin>();
  for (const row of SETTINGS) {
    if (!row.read || row.role === "ignored") {
      continue;
    }
    if (row.role === "section") {
      setAt(tree, row.key, {});
    } else if (row.role === "keyed") {
      const members: Record<string, unknown> = isRecord(row.default) ? { ...row.default } : {};
      provenance.set(row.key, { source: "default", label: "" });
      for (const name of Object.keys(members)) {
        provenance.set(`${row.key}.${name}`, { source: "default", label: "" });
      }
      for (const held of sources.toReversed()) {
        const named = held.supplied.keyed.get(row.key);
        if (named === undefined) {
          continue;
        }
        provenance.set(row.key, originOf(held, row.key));
        for (const [name, value] of Object.entries(named)) {
          members[name] = value;
          provenance.set(`${row.key}.${name}`, originOf(held, row.key));
        }
      }
      if (Object.keys(members).length > 0) {
        provenance.delete(row.key);
      }
      setAt(tree, row.key, canonical(members));
    } else {
      const held = sources.find((one) => one.supplied.values.has(row.key));
      if (held !== undefined) {
        setAt(tree, row.key, held.supplied.values.get(row.key));
        provenance.set(row.key, originOf(held, row.key));
      } else if (row.default !== undefined) {
        setAt(tree, row.key, canonical(row.default));
        provenance.set(row.key, { source: "default", label: "" });
      } else if (enforce && row.required === true) {
        throw new UsageError(
          `${row.key} is not set, it has no default and is never inferred: searched ` +
            `${searched("the repository configuration", inputs.repository)} and ` +
            searched("the central configuration", inputs.central),
        );
      }
    }
  }
  // gen-config.ts marks a member optional exactly where this loop may leave it unset.
  return { config: tree as unknown as PartialConfig, provenance };
}

/**
 * Applies the command-line flags over the repository configuration over the central
 * configuration over the default each key declares, and returns the resolved
 * configuration with the origin of every setting: its keys in the closed key list's
 * order, every object's members inside a value ascending. Every refusal is a
 * {@link UsageError}.
 */
export function resolve(inputs: Inputs): { config: ResolvedConfig; provenance: Provenance } {
  const { config, provenance } = settle(inputs, true);
  return { config: config as ResolvedConfig, provenance };
}

/**
 * The configuration the sources resolve to, refused as {@link resolve} refuses it but
 * with no target kind required: which projects a run analyzes asks none.
 */
export function resolvePartial(inputs: Inputs): PartialConfig {
  return settle(inputs, false).config;
}
