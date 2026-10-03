/** A document written in pieces, joined back into the one string a reader of the file sees. */
export function whole(pieces: Iterable<string>): string {
  return [...pieces].join("");
}
