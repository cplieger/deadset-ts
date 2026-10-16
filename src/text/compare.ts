/**
 * Two strings in the order of their UTF-8 bytes, the order every set of a run is read in.
 * That is code point order, which UTF-16 code unit order (`<` on strings) breaks above
 * U+FFFF: a surrogate unit is below U+E000 while the code point it encodes is above U+FFFF.
 */
export function bytewise(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  const length = Math.min(a.length, b.length);
  for (let at = 0; at < length; at += 1) {
    const x = a.charCodeAt(at);
    const y = b.charCodeAt(at);
    if (x !== y) {
      return ranked(x) < ranked(y) ? -1 : 1;
    }
  }
  return a.length < b.length ? -1 : 1;
}

/** One UTF-16 unit moved so that a surrogate ranks above every unit of U+E000 to U+FFFF. */
function ranked(unit: number): number {
  if (unit >= 0xe000) {
    return unit - 0x800;
  }
  return unit >= 0xd800 ? unit + 0x2000 : unit;
}
