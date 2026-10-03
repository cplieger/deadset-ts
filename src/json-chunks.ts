/**
 * A document written in pieces, so no stage of writing it holds the whole document as
 * one string: a string has a length limit far below what a large report reaches.
 */

/** The length a piece grows to before it is handed on. */
export const CHUNK_LENGTH = 1 << 16;

/**
 * The pieces of `pieces` joined into runs of about {@link CHUNK_LENGTH}, the last one
 * shorter. A piece longer than that is handed on whole.
 */
export function* coalesced(pieces: Iterable<string>): Generator<string, void, undefined> {
  let held: string[] = [];
  let length = 0;
  for (const piece of pieces) {
    held.push(piece);
    length += piece.length;
    if (length >= CHUNK_LENGTH) {
      yield held.join("");
      held = [];
      length = 0;
    }
  }
  if (length > 0) {
    yield held.join("");
  }
}

/** Whether `JSON.stringify` writes nothing for a value where an object member holds it. */
function omitted(value: unknown): boolean {
  return value === undefined || typeof value === "function" || typeof value === "symbol";
}

function* valueOf(
  value: unknown,
  prefix: string,
  step: string,
): Generator<string, void, undefined> {
  // With no indentation the document is compact: no line breaks, and no space after a key.
  const nl = step === "" ? "" : "\n";
  if (Array.isArray(value)) {
    if (value.length === 0) {
      yield "[]";
      return;
    }
    const inner = prefix + step;
    yield "[";
    for (let at = 0; at < value.length; at += 1) {
      yield at === 0 ? `${nl}${inner}` : `,${nl}${inner}`;
      const element: unknown = value[at];
      yield* omitted(element) ? ["null"] : valueOf(element, inner, step);
    }
    yield `${nl}${prefix}]`;
    return;
  }
  if (typeof value === "object" && value !== null) {
    const inner = prefix + step;
    let first = true;
    for (const [key, member] of Object.entries(value)) {
      if (omitted(member)) {
        continue;
      }
      yield `${first ? "{" : ","}${nl}${inner}${JSON.stringify(key)}:${step === "" ? "" : " "}`;
      first = false;
      yield* valueOf(member, inner, step);
    }
    yield first ? "{}" : `${nl}${prefix}}`;
    return;
  }
  yield JSON.stringify(value);
}

/**
 * One JSON document in pieces whose concatenation is the value as `JSON.stringify`
 * writes it at `indent` spaces, followed by a newline. The value is plain data: objects,
 * arrays, strings, finite numbers, booleans and null, an object member holding nothing
 * being left out as `JSON.stringify` leaves it out.
 */
export function jsonChunks(value: unknown, indent: number): Generator<string, void, undefined> {
  return coalesced(
    (function* document(): Generator<string, void, undefined> {
      yield* valueOf(value, "", " ".repeat(indent));
      yield "\n";
    })(),
  );
}
