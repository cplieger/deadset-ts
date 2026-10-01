// A function whose one reference is its own call.

export function recurse(depth: number): number {
  return depth <= 0 ? 0 : recurse(depth - 1);
}
