// hits is read inside its own file here, and written and never read in b.
export let hits = 0;

export function show(): number {
  return hits;
}
