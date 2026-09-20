/**
 * The stable symbol reference: the identifier that names one declaration across
 * runs, across reports, in an ignore entry, in a configured root and in a
 * cross-language edge. It is built from names and containers only, so an edit above
 * a declaration leaves it unchanged, and it is compared as bytes, so there is one
 * canonical spelling per declaration and this module is where that spelling is
 * written.
 *
 * The position key of {@link ./position.ts} is the other identifier and has the
 * other job: it locates a finding inside one run, and the two never mix.
 */

/** The language prefix, which namespaces every reference this analyzer emits. */
const PREFIX = "ts://";

/**
 * The building blocks of the reference grammar, spelled in the intersection of the
 * two regular-expression dialects a reference is checked in: Go's `regexp` and an
 * ECMAScript `RegExp` with no flags. Neither dialect offers a Unicode identifier
 * property without a flag, so a character outside ASCII is admitted as a class;
 * the expressions check the form of a reference and never validate a name, because
 * the compiler that accepted the declaration has already validated it.
 */
const TS_IDENT = String.raw`(?:[A-Za-z_$]|[^\x00-\x7F])(?:[A-Za-z0-9_$]|[^\x00-\x7F])*`;
const TS_QUOTED = String.raw`'(?:[^'\\\r\n]|\\['\\nr])*'`;
const TS_COMPUTED = String.raw`\[[^\]\r\n\t ]+\]`;
const TS_HEAD = `(?:${TS_IDENT}|${TS_QUOTED})`;
const TS_MEMBER = `(?:${TS_IDENT}|#${TS_IDENT}|${TS_QUOTED}|${TS_COMPUTED})`;
const TS_PACKAGE = String.raw`(?:@[A-Za-z0-9._-]+/)?[A-Za-z0-9._-]+`;
const TS_FILE = String.raw`(?:[^/#\r\n]+/)*[^/#\r\n]+(?:(?:\.d)?\.[mc]?ts|\.tsx|\.[mc]?js|\.jsx)`;

const SCOPE = `${PREFIX}${TS_PACKAGE}/${TS_FILE}`;
const MANIFEST_SCOPE = `${PREFIX}${TS_PACKAGE}/package\\.json`;

/**
 * One expression per form the grammar defines, each anchored and each the whole of
 * a reference. Several forms share one expression because they differ in what the
 * symbol is rather than in how the reference is spelled, so the list is the set of
 * spellings and not the set of subjects. A reference is valid when it matches one.
 *
 * They are written here rather than read from the Contract at run time: the Contract
 * is data a reader outside this program consults, and a product that read it while
 * running would need it installed beside itself. A test compares this list against
 * the release this analyzer is written against, so a grammar that grows a form
 * arrives here as a failing test.
 */
export const REF_EXPRESSIONS: readonly string[] = [
  `^${SCOPE}#$`,
  `^${SCOPE}#${TS_HEAD}$`,
  `^${SCOPE}#${TS_HEAD}:alias$`,
  `^${SCOPE}#${TS_HEAD}(?:\\.${TS_MEMBER})+$`,
  `^${SCOPE}#${TS_HEAD}(?:\\.${TS_MEMBER})+:static$`,
  `^${SCOPE}#${TS_HEAD}(?:\\.${TS_MEMBER})*(?::static)?<${TS_IDENT}>$`,
  `^${MANIFEST_SCOPE}#${TS_PACKAGE}:(?:dependency|dev-dependency|peer-dependency)$`,
];

const REF_FORMS: readonly RegExp[] = REF_EXPRESSIONS.map(
  (expression) => new RegExp(expression, "u"),
);

const IDENTIFIER = new RegExp(`^${TS_IDENT}$`, "u");
const PRIVATE_NAME = new RegExp(`^#${TS_IDENT}$`, "u");
const ASCII_WHITESPACE = /[\t\n\v\f\r ]/gu;

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
 * One component of a fragment: a declared name, or the source text of a computed
 * key. The two are spelled differently and cannot be told apart from the text
 * alone, so the caller says which it has.
 */
export interface Component {
  /** The declared name, or the source text between the brackets of a computed key. */
  readonly text: string;
  /** Whether the text is a computed key rather than a name. */
  readonly computed: boolean;
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
  /** One export specifier, a symbol of its own beside the declaration it names. */
  | { readonly of: "alias"; readonly name: string }
  /** One dependency of a manifest, scoped by that manifest. */
  | { readonly of: "dependency"; readonly name: string; readonly section: DependencySection };

/**
 * The canonical spelling of one declared name as a fragment component: bare when
 * the name is an identifier name, reserved words included; with its leading number
 * sign kept when the name is a private name, because the sign is part of the name
 * in the language and a class may declare both spellings side by side; and in
 * single quotes otherwise. The quotes are single so that a reference sits inside a
 * JSON string with no escaping, which is where every document carries one.
 */
export function nameComponent(name: string): string {
  if (IDENTIFIER.test(name) || PRIVATE_NAME.test(name)) {
    return name;
  }
  const escaped = name
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "\\'")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r");
  return `'${escaped}'`;
}

/**
 * The canonical spelling of one computed key: its source text between square
 * brackets with every ASCII whitespace character removed. The text is compared as
 * written, so two spellings of one well-known symbol are two references, which is
 * right, because they are two declarations.
 */
export function computedComponent(text: string): string {
  return `[${text.replaceAll(ASCII_WHITESPACE, "")}]`;
}

function spell(component: Component): string {
  return component.computed ? computedComponent(component.text) : nameComponent(component.text);
}

/**
 * The reference of one symbol. The chain of a declaration fragment is read from the
 * module-level declaration inward and is never empty; the module fragment is what
 * names the module itself.
 */
export function renderRef(module: Module, fragment: Fragment): string {
  const scope = `${PREFIX}${module.package}/${module.path}`;
  switch (fragment.of) {
    case "module":
      return `${scope}#`;
    case "alias":
      return `${scope}#${nameComponent(fragment.name)}:alias`;
    case "dependency":
      return `${scope}#${fragment.name}:${fragment.section}`;
    case "declaration": {
      const chain = fragment.chain.map(spell).join(".");
      const isStatic = fragment.static ? ":static" : "";
      const parameter = fragment.typeParameter === undefined ? "" : `<${fragment.typeParameter}>`;
      return `${scope}#${chain}${isStatic}${parameter}`;
    }
  }
}

/**
 * Whether one string is a reference of this language's grammar, in its canonical
 * spelling. A string that is not, whether misspelled or spelled in a form the
 * grammar does not define, matches no symbol; a reference of another language is
 * not one of this language's either, which is what the language prefix is for.
 */
export function isRef(value: string): boolean {
  return REF_FORMS.some((form) => form.test(value));
}
