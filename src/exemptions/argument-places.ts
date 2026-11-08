/**
 * Which parameter place each argument of a call binds, the one reading every question
 * about a call's arguments asks. A plain argument fills the next place, and a spread or
 * an `apply` list typed as a tuple whose elements are all required fills one place per
 * element. Any other spread or list has no known length: from its first place on, each of
 * its element types, and every later argument, may fill any place, so a value is never
 * read as missing a parameter only because its place could not be read. The type at each
 * place is the checker's answer for it, so this reading names places and never types them.
 */

import { isSpreadElement, type Expression } from "@typescript/native/ast";
import { ElementFlags, type Signature, type Type } from "@typescript/native/sync";
import { must } from "../query.ts";
import type { ProjectView } from "../session.ts";

/** The places one argument fills. */
export interface Span {
  /** The argument's index among the invocation's arguments. */
  readonly argument: number;
  /** The first place it can fill. */
  readonly first: number;
  /** The type at each place from `first` on, or, where `open`, at any place from it on. */
  readonly given: readonly (Type | undefined)[];
  /** Whether the argument's length, or the length of a spread before it, is unknown. */
  readonly open: boolean;
  /** Whether the argument is a spread or a list, whose value is its elements. */
  readonly spread: boolean;
}

/** One argument at one parameter place, with the type it gives there. */
export interface Placed {
  readonly argument: number;
  /** The index in the argument's span `given` of the type it gives there. */
  readonly element: number;
  readonly place: number;
  readonly given: Type | undefined;
  /** Whether the signature has no such place, so it says nothing of what the argument keeps. */
  readonly uncovered: boolean;
  /**
   * Whether it stands for every place of a rest from `place` on, an argument of unknown
   * length there taking any type the rest's element type holds.
   */
  readonly rest: boolean;
}

/**
 * How many places a signature has. Where it `repeats`, its rest has no fixed length and
 * `count` ends at the rest's first place: the checker answers each place past it, and an
 * argument of unknown length meets every one of them.
 */
export interface Layout {
  readonly count: number;
  readonly repeats: boolean;
}

/** The element flags of a tuple type; none for another type. */
function elementFlags<Brand>(project: ProjectView<Brand>, type: Type): readonly ElementFlags[] {
  const target = type.isTupleType() ? must(project.queries.targetOf(type)) : undefined;
  return target?.isTupleTypeTarget() === true ? target.elementFlags : [];
}

/** What a spread argument puts at the places it fills, and how many it fills at least. */
function spread<Brand>(
  project: ProjectView<Brand>,
  type: Type | undefined,
): {
  readonly types: readonly (Type | undefined)[];
  readonly fixed: boolean;
  readonly least: number;
} {
  const { queries } = project;
  if (type === undefined) {
    return { types: [undefined], fixed: false, least: 0 };
  }
  if (type.isTupleType()) {
    const flags = elementFlags(project, type);
    return {
      types: must(queries.typeArguments(type)).slice(0, flags.length),
      fixed: flags.every((flag) => (flag & ElementFlags.Required) !== 0),
      least: flags.filter((flag) => (flag & ElementFlags.Required) !== 0).length,
    };
  }
  if (must(queries.isArray(type))) {
    return { types: must(queries.typeArguments(type)), fixed: false, least: 0 };
  }
  // Another iterable's elements are read off its type arguments, as `Set<T>` holds `T`.
  return { types: [type, ...must(queries.typeArguments(type))], fixed: false, least: 0 };
}

/** The element types of a tuple of `count` required elements; none for another type. */
export function knownElements<Brand>(
  project: ProjectView<Brand>,
  type: Type,
  count: number,
): readonly (Type | undefined)[] | undefined {
  if (!type.isTupleType()) {
    return undefined;
  }
  const elements = spread(project, type);
  return elements.fixed && elements.types.length === count ? elements.types : undefined;
}

/**
 * The places each argument fills, `types` holding the type of each argument's value; it
 * may be empty where no argument is a spread and no given type is read. `listed` reads
 * the last argument as a list whose elements the places bind.
 */
export function spansOf<Brand>(
  project: ProjectView<Brand>,
  args: readonly Expression[],
  listed: boolean,
  types: readonly (Type | undefined)[],
): readonly Span[] {
  const spans: Span[] = [];
  let place = 0;
  let open = false;
  for (const [at, argument] of args.entries()) {
    const type = types[at];
    if (!isSpreadElement(argument) && !(listed && at === args.length - 1)) {
      spans.push({ argument: at, first: place, given: [type], open, spread: false });
      place += 1;
      continue;
    }
    const elements = spread(project, type);
    open ||= !elements.fixed;
    spans.push({ argument: at, first: place, given: elements.types, open, spread: true });
    place += elements.least;
  }
  return spans;
}

/**
 * The places of one signature as the checker counts them: one per parameter, and in
 * place of a rest as many as the `length` the checker answers for its type, where that
 * is a number literal or a union of them. Any other `length`, an array's or an array-like
 * interface's `number` among them, leaves the rest open.
 */
export function layoutOf<Brand>(project: ProjectView<Brand>, signature: Signature): Layout {
  const { queries } = project;
  const fixed = signature.parameters.length;
  const rest = must(queries.restTypeOf(signature));
  if (rest === undefined) {
    return { count: fixed, repeats: false };
  }
  const length = must(queries.propertyTypeOf(rest, "length"));
  const lengths = length === undefined ? [] : must(queries.constituents(length));
  const bounds = lengths.flatMap((one) => (one.isNumberLiteralType() ? [one.value] : []));
  if (bounds.length > 0 && bounds.length === lengths.length) {
    return { count: fixed - 1 + Math.max(...bounds), repeats: false };
  }
  return { count: fixed, repeats: true };
}

/**
 * The parameter place each argument binds in a signature of `layout`, with the type it
 * gives there. A span of unknown length binds every place from its first to the last the
 * layout counts, and past them, where the rest is open, one `rest` placement for every
 * later place, or else its first place alone. A place past every place of a layout that
 * does not repeat is `uncovered`.
 */
export function placesIn(spans: readonly Span[], layout: Layout): readonly Placed[] {
  const placed: Placed[] = [];
  const add = (span: Span, place: number, rest: boolean): void => {
    const uncovered = place >= layout.count && !layout.repeats;
    const elements = span.open
      ? span.given.map((given, element) => ({ given, element }))
      : [{ given: span.given[place - span.first], element: place - span.first }];
    placed.push(
      ...elements.map((one) => ({ argument: span.argument, place, uncovered, rest, ...one })),
    );
  };
  for (const span of spans) {
    const open = span.open && layout.repeats;
    const end = !span.open
      ? span.first + span.given.length
      : Math.max(layout.count, open ? span.first : span.first + 1);
    for (let place = span.first; place < end; place += 1) {
      add(span, place, false);
    }
    if (open) {
      add(span, Math.max(layout.count, span.first), true);
    }
  }
  return placed;
}

/**
 * Whether a span fills the parameter declared at `index`, a rest parameter every place
 * from it on; with `element`, whether that element of a span that is not open does.
 */
export function fills(span: Span, index: number, rest: boolean, element?: number): boolean {
  if (element !== undefined && !span.open) {
    const place = span.first + element;
    return rest ? place >= index : place === index;
  }
  const last = span.open ? Number.POSITIVE_INFINITY : span.first + span.given.length - 1;
  return rest ? last >= index : span.first <= index && index <= last;
}
