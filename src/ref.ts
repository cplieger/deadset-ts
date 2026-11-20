/**
 * The stable symbol reference: the identifier that names one declaration across runs,
 * reports, ignore entries, configured roots and cross-language edges. It is built from
 * names and containers only, so an edit above a declaration leaves it unchanged, and it
 * is compared as bytes, so this module writes the one canonical spelling. The position
 * key of {@link ./position.ts} locates a finding inside one run; the two never mix.
 */

import { UNSAFE_RANGES } from "./contract/contract.generated.ts";
import { expression } from "./text/expression.ts";

/** The language prefix, which namespaces every reference this analyzer emits. */
const PREFIX = "ts://";

/**
 * The building blocks of the reference grammar, in the intersection of Go's `regexp` and
 * a flagless ECMAScript `RegExp`. Neither offers a Unicode identifier property without a
 * flag, so a character outside ASCII is admitted as a class: the expressions check a
 * reference's form, and the compiler that accepted a declaration validated its name. No
 * escape spells a code point past U+00FF in both, so a class holds the grammar's rule 5
 * whitespace past it as the characters themselves, one by one.
 */
const WIDE_SPACE =
  "\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF";
/** The Bidi_Control characters, which a class past U+00FF excludes after the wide whitespace. */
const BIDI = "\u061C\u200E\u200F\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069";
const WIDE_EXCLUDED = `${WIDE_SPACE}${BIDI}`;
/** The line and paragraph separators. */
const SEPARATORS = "\u2028\u2029";
/** The controls and the whitespace below U+0100: C0, the space, DEL, C1 and the no-break space. */
const NARROW_EXCLUDED = String.raw`\x00-\x20\x7F-\xA0`;
const TS_IDENT_CHARACTER = String.raw`[^\x00-\xA0${WIDE_EXCLUDED}]`;
const TS_IDENT = String.raw`(?:[A-Za-z_$]|${TS_IDENT_CHARACTER})(?:[A-Za-z0-9_$]|${TS_IDENT_CHARACTER})*`;
/** The escape of a character of the unsafe set other than a tab, LF and CR, as {@link quoted} writes it. */
const UNSAFE_ESCAPE = String.raw`\\u\{(?:[0-8BCEF]|1[0-9A-F]|7F|[89][0-9A-F]|61C|200[EF]|202[89A-E]|206[6-9]|D[89A-F][0-9A-F]{2})\}`;
/** A quoted component holds no character of the unsafe set raw but a tab. */
const TS_QUOTED = String.raw`'(?:[^'\\\x00-\x08\x0A-\x1F\x7F-\x9F${BIDI}${SEPARATORS}]|\\['\\nr]|${UNSAFE_ESCAPE})*'`;
const TS_COMPUTED = String.raw`\[[^\]${NARROW_EXCLUDED}${WIDE_EXCLUDED}]+\]`;
const TS_HEAD = `(?:${TS_IDENT}|${TS_QUOTED})`;
const TS_MEMBER = `(?:${TS_IDENT}|#${TS_IDENT}|${TS_QUOTED}|${TS_COMPUTED})`;
const PCT = "%[0-9A-F]{2}";
const TS_PACKAGE_PART = String.raw`(?:[A-Za-z0-9._-]|${PCT})+`;
const TS_PACKAGE = `(?:@${TS_PACKAGE_PART}/)?${TS_PACKAGE_PART}`;
const TS_SEG_CHARACTER = String.raw`[^${NARROW_EXCLUDED}${WIDE_EXCLUDED}/#%*?]`;
const TS_SEG = `(?:${TS_SEG_CHARACTER}|${PCT})+`;
const TS_DIRS = `(?:${TS_SEG}/)*`;
// No reference names a `.json` file: it declares nothing, and a manifest scopes only a dependency.
const TS_EXT = String.raw`(?:[A-Za-z0-9]{1,3}|[A-Za-ik-z0-9][A-Za-z0-9]{3}|j[A-Za-rt-z0-9][A-Za-z0-9]{2}|js[A-Za-np-z0-9][A-Za-z0-9]|jso[A-Za-mo-z0-9]|[A-Za-z0-9]{5,})`;
const TS_FILE = String.raw`${TS_DIRS}${TS_SEG}\.${TS_EXT}`;

const SCOPE = `${PREFIX}${TS_PACKAGE}/${TS_FILE}`;
const MANIFEST_SCOPE = `${PREFIX}${TS_PACKAGE}/${TS_DIRS}package\\.json`;

const SHAPE_SCOPE = String.raw`(?:[^${NARROW_EXCLUDED}${WIDE_EXCLUDED}#%*]|${PCT})+`;
const SHAPE_PLAIN = String.raw`(?:[^${NARROW_EXCLUDED}${WIDE_EXCLUDED}'\[\]*%]|${PCT})`;
const SHAPE_FRAGMENT = `(?:${SHAPE_PLAIN}|${TS_QUOTED}|${TS_COMPUTED})*`;

/**
 * The shape every document checks a reference of any language for, written from the same
 * blocks as the forms so that it admits every reference they do; a test compares it with
 * the expression the Contract publishes.
 */
export const REF_SHAPE = `^[a-z][a-z0-9]*://${SHAPE_SCOPE}#${SHAPE_FRAGMENT}$`;

const SHAPE = expression(REF_SHAPE);

/**
 * Whether one string is in the shape every document checks: an edge side, an ignore entry
 * and a baseline row of any language outside it are malformed, while one in it that its
 * language does not define is a reference that names nothing.
 */
export function hasRefShape(value: string): boolean {
  return SHAPE.test(value);
}

/**
 * One anchored expression per spelling the grammar defines; a reference is valid when it
 * matches one. They are written here rather than read from the Contract at run time, so
 * the product needs no Contract installed beside it; a test compares this list against
 * the release this analyzer implements, so a grammar that grows a form fails it.
 */
export const REF_EXPRESSIONS: readonly string[] = [
  `^${SCOPE}#$`,
  `^${SCOPE}#${TS_HEAD}$`,
  `^${SCOPE}#(?:${TS_QUOTED}\\.)?${TS_HEAD}:alias$`,
  `^${SCOPE}#${TS_HEAD}:import$`,
  `^${SCOPE}#${TS_HEAD}(?:\\.${TS_MEMBER})+$`,
  `^${SCOPE}#${TS_HEAD}(?:\\.${TS_MEMBER})+:static$`,
  `^${SCOPE}#${TS_HEAD}(?:\\.${TS_MEMBER})+\\.${TS_QUOTED}:case$`,
  `^${SCOPE}#${TS_HEAD}(?:\\.${TS_MEMBER})*(?::static)?<${TS_IDENT}>$`,
  `^${SCOPE}#(?:${TS_HEAD}(?:\\.${TS_MEMBER})*(?::static)?)?\\(${TS_IDENT}\\)$`,
  `^${MANIFEST_SCOPE}#${TS_PACKAGE}:(?:dependency|dev-dependency|peer-dependency)$`,
];

const REF_FORMS = REF_EXPRESSIONS.map((form) => expression(form));

/** The characters a package component spells as they are. */
const PACKAGE_CHARACTER = /^[A-Za-z0-9._-]$/u;
/** The characters a source-path segment spells as they are: a lone surrogate is no UTF-8 character. */
const PATH_CHARACTER = new RegExp(String.raw`^(?![\uD800-\uDFFF])${TS_SEG_CHARACTER}$`, "u");
const SCOPED = /^@([^/]+)\/([^/]+)$/u;

/** The UTF-8 bytes of one code point, a lone surrogate encoded as its own value. */
function utf8(code: number): readonly number[] {
  if (code < 0x80) {
    return [code];
  }
  if (code < 0x800) {
    return [0xc0 | (code >> 6), 0x80 | (code & 0x3f)];
  }
  if (code < 0x10000) {
    return [0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f)];
  }
  return [
    0xf0 | (code >> 18),
    0x80 | ((code >> 12) & 0x3f),
    0x80 | ((code >> 6) & 0x3f),
    0x80 | (code & 0x3f),
  ];
}

/** One byte as an escape, with uppercase digits. */
function escaped(byte: number): string {
  return `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
}

/**
 * One text with every UTF-8 byte of a character outside `kept` percent-encoded in
 * uppercase (RFC 3986, section 2.1).
 */
function percentEncoded(text: string, kept: RegExp): string {
  let out = "";
  for (let at = 0; at < text.length;) {
    const code = text.codePointAt(at) ?? 0;
    at += code > 0xffff ? 2 : 1;
    const character = String.fromCodePoint(code);
    out += kept.test(character) ? character : utf8(code).map(escaped).join("");
  }
  return out;
}

/**
 * The canonical spelling of a package name as a package component: the `@` and the `/`
 * of a scoped name kept, and every other byte outside the grammar's set percent-encoded
 * (RFC 3986, section 2.1), so a name npm installed under its older rules is spelled too.
 */
function packageComponent(name: string): string {
  const scoped = SCOPED.exec(name);
  return scoped === null
    ? percentEncoded(name, PACKAGE_CHARACTER)
    : `@${percentEncoded(scoped[1] ?? "", PACKAGE_CHARACTER)}/${percentEncoded(scoped[2] ?? "", PACKAGE_CHARACTER)}`;
}

/** The canonical spelling of a source path: each segment as `symbol-ref.md` "Path segments" states. */
function pathComponent(path: string): string {
  return path
    .split("/")
    .map((segment) => percentEncoded(segment, PATH_CHARACTER))
    .join("/");
}

/**
 * A path as a report, a facts document or a baseline carries it, every character as the
 * file name holds it. Every path those documents carry is built through it, so their
 * spelling is decided in one place.
 */
export function reportedPath(path: string): string {
  return path;
}

/**
 * The length of the sequence a lead byte opens and the range its second byte takes in
 * well-formed UTF-8 (RFC 3629, section 4), or undefined for a byte that opens none.
 */
function sequenceOf(lead: number): readonly [number, number, number] | undefined {
  if (lead >= 0xc2 && lead <= 0xdf) {
    return [2, 0x80, 0xbf];
  }
  if (lead === 0xe0) {
    return [3, 0xa0, 0xbf];
  }
  if (lead === 0xed) {
    return [3, 0x80, 0x9f];
  }
  if (lead >= 0xe1 && lead <= 0xef) {
    return [3, 0x80, 0xbf];
  }
  if (lead === 0xf0) {
    return [4, 0x90, 0xbf];
  }
  if (lead === 0xf4) {
    return [4, 0x80, 0x8f];
  }
  if (lead >= 0xf1 && lead <= 0xf3) {
    return [4, 0x80, 0xbf];
  }
  return undefined;
}

/**
 * The well-formed UTF-8 character `bytes` holds at `at`, or undefined where none starts
 * there. Decoded by hand because the published API compiles with no runtime's types, so
 * `TextDecoder` is not in scope.
 */
function characterAt(bytes: Uint8Array, at: number): string | undefined {
  const lead = bytes[at] ?? 0xff;
  if (lead < 0x80) {
    return String.fromCodePoint(lead);
  }
  const sequence = sequenceOf(lead);
  if (sequence === undefined || at + sequence[0] > bytes.length) {
    return undefined;
  }
  const [length, low, high] = sequence;
  let code = lead & (0xff >> (length + 1));
  for (let next = 1; next < length; next += 1) {
    const byte = bytes[at + next] ?? 0;
    if (byte < (next === 1 ? low : 0x80) || byte > (next === 1 ? high : 0xbf)) {
      return undefined;
    }
    code = (code << 6) | (byte & 0x3f);
  }
  return String.fromCodePoint(code);
}

/** The canonical spelling of a segment's bytes, which may hold any byte a file name may. */
function spelledBytes(bytes: Uint8Array): string {
  let out = "";
  for (let at = 0; at < bytes.length;) {
    const character = characterAt(bytes, at);
    if (character !== undefined && PATH_CHARACTER.test(character)) {
      out += character;
      at += utf8(character.codePointAt(0) ?? 0).length;
    } else {
      out += escaped(bytes[at] ?? 0);
      at += 1;
    }
  }
  return out;
}

const ESCAPE = /^%[0-9A-F]{2}$/u;

/**
 * The bytes one source-path segment of a reference spells, or undefined where the text
 * is not the canonical spelling of a segment: empty, holding a `%` that opens no escape
 * with uppercase digits, decoding to a `/`, to `.` or to `..`, which name no file and
 * would lead a reader joining the segments out of its directory, or spelled otherwise
 * than its bytes encode to, which is the spelling of no file.
 */
export function readPathSegment(spelled: string): Uint8Array | undefined {
  const bytes: number[] = [];
  for (let at = 0; at < spelled.length;) {
    if (spelled[at] === "%") {
      const escape = spelled.slice(at, at + 3);
      if (!ESCAPE.test(escape)) {
        return undefined;
      }
      bytes.push(Number.parseInt(escape.slice(1), 16));
      at += 3;
      continue;
    }
    const code = spelled.codePointAt(at) ?? 0;
    at += code > 0xffff ? 2 : 1;
    bytes.push(...utf8(code));
  }
  const read = Uint8Array.from(bytes);
  const dots = read.every((byte) => byte === 0x2e) && read.length <= 2;
  return bytes.length > 0 && !dots && !read.includes(0x2f) && spelledBytes(read) === spelled
    ? read
    : undefined;
}

/** ECMAScript's IdentifierStart and IdentifierPart past ASCII, each against one code point. */
const IDENTIFIER_START = /^[\p{ID_Start}$_]$/u;
const IDENTIFIER_PART = /^[\p{ID_Continue}$\u200C\u200D]$/u;
/** For each ASCII code point, whether an identifier may hold it: a letter, digit, `$` or `_`. */
const ASCII_PART = Array.from({ length: 0x80 }, (_, point) =>
  /[$\w]/u.test(String.fromCharCode(point)),
);

/** Whether a name is an ECMAScript IdentifierName, per code point, as one expression overflows. */
export function isIdentifierName(name: string): boolean {
  for (let at = 0; at < name.length;) {
    const point = name.codePointAt(at) ?? 0;
    const ok =
      point < 0x80
        ? ASCII_PART[point] === true && (at > 0 || point < 0x30 || point > 0x39)
        : (at === 0 ? IDENTIFIER_START : IDENTIFIER_PART).test(String.fromCodePoint(point));
    if (!ok) {
      return false;
    }
    at += point > 0xffff ? 2 : 1;
  }
  return name.length > 0;
}
/** The whitespace of the grammar's rule 5: Unicode's White_Space and U+FEFF. */
const WHITESPACE = new RegExp(String.raw`[\t-\r \x85\xA0${WIDE_SPACE}]`, "gu");

/** The section of a manifest that declares a dependency. */
export type DependencySection = "dependency" | "dev-dependency" | "peer-dependency";

/** The scope half of a reference: the package a file belongs to, and its path in it. */
export interface Module {
  /**
   * The name of the package the file belongs to, or a single dot where no manifest
   * at or above it up to the target root carries one. The two cannot collide,
   * because a package name never starts with a dot.
   */
  readonly package: string;
  /** The file's path inside that package, with its own extension. */
  readonly path: string;
}

/**
 * One component of a fragment: a declared name as the language holds it, or the source
 * text of a computed key. The kinds are spelled differently and cannot be told apart
 * from the text alone, as the string key `"#a"` and the private name `#a` share it, so
 * the caller says which it has.
 */
export interface Component {
  /**
   * A key's value, escapes resolved and a numeric key in its value's string form (`0x10`
   * is `16`); a private name with its number sign, followed by an IdentifierName; or the
   * source text between the brackets of a computed key.
   */
  readonly text: string;
  /** A key (an identifier, a string or a number), a private name, or a computed key. */
  readonly kind: "key" | "private" | "computed";
}

/** What one reference's fragment names. */
export type Fragment =
  /** The module itself, which is the parent of every module-level declaration. */
  | { readonly of: "module" }
  /**
   * One declaration, named by the chain of components from the module inward with
   * its own last. A static member of a class is always marked, whether or not the
   * class also declares an instance member of that name, so the spelling does not
   * depend on what else the class declares. A type parameter is the declaring
   * function's or method's own chain followed by the parameter's name.
   */
  | {
      readonly of: "declaration";
      readonly chain: readonly Component[];
      readonly static: boolean;
      readonly typeParameter?: string;
    }
  /**
   * One export specifier, a symbol of its own beside the declaration it names. One
   * written inside a `declare module` block carries the block's name, which is always
   * quoted, so the aliases two blocks of one file declare under one name stay apart.
   */
  | { readonly of: "alias"; readonly name: string; readonly block?: string }
  /** One dependency of a manifest, scoped by that manifest. */
  | { readonly of: "dependency"; readonly name: string; readonly section: DependencySection };

/**
 * The canonical spelling of one key's value as a fragment component: bare when the value
 * is an ECMAScript IdentifierName, reserved words included, and in single quotes
 * otherwise, so the string key `"#a"` is `'#a'`. A private name is spelled by
 * {@link spell}. The quotes are single so that a reference sits inside a JSON string
 * with no escaping, which is where every document carries one.
 */
export function nameComponent(name: string): string {
  return isIdentifierName(name) ? name : quoted(name);
}

/**
 * Whether one code point is in the grammar's unsafe set, or is half of a surrogate pair,
 * which a UTF-16 name holds only standing alone when iterated by code point.
 */
export function isUnsafe(point: number): boolean {
  return (
    (point >= 0xd800 && point <= 0xdfff) ||
    UNSAFE_RANGES.some(([first, last]) => point >= first && point <= last)
  );
}

/**
 * The spelling of a key's value in quotes whatever it holds, as a case constituent's
 * discriminant takes it.
 */
export function quotedComponent(name: string): string {
  return quoted(name);
}

/**
 * A value in quotes: a quote and a backslash escaped, LF as `\n`, CR as `\r`, a tab as
 * itself, and every other character of the unsafe set as `\u{H}` in uppercase hexadecimal
 * with no leading zero, so every value has one spelling and no reference carries a
 * character a terminal acts on or a viewer reorders around.
 */
function quoted(name: string): string {
  let out = "";
  for (const character of name) {
    const point = character.codePointAt(0) ?? 0;
    if (character === "\\" || character === "'") {
      out += `\\${character}`;
    } else if (point === 0x0a) {
      out += "\\n";
    } else if (point === 0x0d) {
      out += "\\r";
    } else if (point !== 0x09 && isUnsafe(point)) {
      out += `\\u{${point.toString(16).toUpperCase()}}`;
    } else {
      out += character;
    }
  }
  return `'${out}'`;
}

/**
 * The canonical spelling of one computed key: its source text between square
 * brackets with every whitespace character of the grammar's rule 5 removed. The text
 * is compared as written, so two spellings of one well-known symbol are two
 * references, which is right, because they are two declarations.
 */
export function computedComponent(text: string): string {
  return `[${text.replaceAll(WHITESPACE, "")}]`;
}

/**
 * Whether a computed key's source text has a spelling: none holds `]`, which would close
 * its brackets, or a character of the unsafe set the removal of whitespace leaves in it.
 */
export function hasComputedSpelling(text: string): boolean {
  if (text.includes("]")) {
    return false;
  }
  for (const character of computedComponent(text)) {
    if (isUnsafe(character.codePointAt(0) ?? 0)) {
      return false;
    }
  }
  return true;
}

/** The reference of an import binding, read against the reference of the module that holds it. */
export function importRef(moduleRef: string, name: string): string {
  return `${moduleRef}${nameComponent(name)}:import`;
}

/** The reference of a parameter, read against the reference of the declaration that holds it. */
export function parameterRef(holderRef: string, name: string): string {
  return `${holderRef}(${name})`;
}

/** The fragment of an export alias, inside the `declare module` block named, if one is. */
export function aliasFragment(name: string, block?: string): string {
  const head = block === undefined ? "" : `${quoted(block)}.`;
  return `${head}${nameComponent(name)}:alias`;
}

/**
 * The canonical spelling of one component: a key by its value, a private name with its
 * number sign, which no key's spelling starts with, and a computed key in brackets.
 */
export function spell(component: Component): string {
  switch (component.kind) {
    case "key":
      return nameComponent(component.text);
    case "private":
      return component.text;
    case "computed":
      return computedComponent(component.text);
  }
}

/**
 * The reference of one symbol. The chain of a declaration fragment is read from the
 * module-level declaration inward and is never empty; the module fragment is what
 * names the module itself.
 */
export function renderRef(module: Module, fragment: Fragment): string {
  const scope = `${PREFIX}${packageComponent(module.package)}/${pathComponent(module.path)}`;
  switch (fragment.of) {
    case "module":
      return `${scope}#`;
    case "alias":
      return `${scope}#${aliasFragment(fragment.name, fragment.block)}`;
    case "dependency":
      return `${scope}#${packageComponent(fragment.name)}:${fragment.section}`;
    case "declaration": {
      const chain = fragment.chain.map(spell).join(".");
      const isStatic = fragment.static ? ":static" : "";
      const parameter = fragment.typeParameter === undefined ? "" : `<${fragment.typeParameter}>`;
      return `${scope}#${chain}${isStatic}${parameter}`;
    }
  }
}

/**
 * One declaration's key among a run's: its reference and the file that declares it. Two
 * packages of one name spell one reference for two declarations, so the reference alone
 * keys neither.
 */
export function declarationKey(ref: string, path: string): string {
  return `${ref}\u0000${path}`;
}

/**
 * Whether one string is a reference of this language's grammar, in its canonical
 * spelling. A string that is not, whether misspelled or spelled in a form the
 * grammar does not define, matches no symbol; a reference of another language is
 * not one of this language's either, which is what the language prefix is for.
 */
export function isRef(value: string): boolean {
  return value.isWellFormed() && REF_FORMS.some((form) => form.test(value));
}
