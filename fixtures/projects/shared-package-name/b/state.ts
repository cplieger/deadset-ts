// hits is written and never read here, and read inside its own file in a.
export let hits = 0;

export function bump(): void {
  hits = 1;
}
