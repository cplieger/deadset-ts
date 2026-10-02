/**
 * SHA-256 over the UTF-8 encoding of a string, computed synchronously in the module itself:
 * a rendering is a pure function of the report, and the platform's own digests are either
 * asynchronous or reached through a platform module the analysis does not import.
 */

/** The first 32 bits of the fractional parts of the cube roots of the first 64 primes. */
const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** The first 32 bits of the fractional parts of the square roots of the first eight primes. */
const INITIAL_STATE = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

/** The replacement character's encoding, written for a lone surrogate, which has no code point. */
const REPLACEMENT = [0xef, 0xbf, 0xbd];

/** The UTF-8 encoding of a string. */
export function utf8Bytes(text: string): number[] {
  const bytes: number[] = [];
  for (const char of text) {
    const point = char.codePointAt(0) ?? 0;
    if (point < 0x80) {
      bytes.push(point);
    } else if (point < 0x800) {
      bytes.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f));
    } else if (point >= 0xd800 && point <= 0xdfff) {
      bytes.push(...REPLACEMENT);
    } else if (point < 0x10000) {
      bytes.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
    } else {
      bytes.push(
        0xf0 | (point >> 18),
        0x80 | ((point >> 12) & 0x3f),
        0x80 | ((point >> 6) & 0x3f),
        0x80 | (point & 0x3f),
      );
    }
  }
  return bytes;
}

function rotate(value: number, by: number): number {
  return (value >>> by) | (value << (32 - by));
}

/** The message padded to a whole number of 64-byte blocks, its bit length in the last eight bytes. */
function padded(bytes: readonly number[]): Uint8Array {
  const length = Math.ceil((bytes.length + 9) / 64) * 64;
  const block = new Uint8Array(length);
  block.set(bytes);
  block[bytes.length] = 0x80;
  const bits = bytes.length * 8;
  const view = new DataView(block.buffer);
  view.setUint32(length - 8, Math.floor(bits / 0x100000000));
  view.setUint32(length - 4, bits >>> 0);
  return block;
}

/** The SHA-256 digest of a string's UTF-8 encoding, as 64 lowercase hexadecimal digits. */
export function sha256Hex(text: string): string {
  const message = padded(utf8Bytes(text));
  const view = new DataView(message.buffer);
  const state = [...INITIAL_STATE];
  const words = new Uint32Array(64);
  for (let offset = 0; offset < message.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      words[i] = view.getUint32(offset + i * 4);
    }
    for (let i = 16; i < 64; i += 1) {
      const early = words[i - 15] ?? 0;
      const late = words[i - 2] ?? 0;
      const s0 = rotate(early, 7) ^ rotate(early, 18) ^ (early >>> 3);
      const s1 = rotate(late, 17) ^ rotate(late, 19) ^ (late >>> 10);
      words[i] = (words[i - 16] ?? 0) + s0 + (words[i - 7] ?? 0) + s1;
    }
    let [a, b, c, d, e, f, g, h] = state as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    for (let i = 0; i < 64; i += 1) {
      const t1 =
        (h +
          (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) +
          ((e & f) ^ (~e & g)) +
          (ROUND_CONSTANTS[i] ?? 0) +
          (words[i] ?? 0)) >>>
        0;
      const t2 =
        ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, h].forEach((value, i) => {
      state[i] = ((state[i] ?? 0) + value) >>> 0;
    });
  }
  return state.map((word) => word.toString(16).padStart(8, "0")).join("");
}
