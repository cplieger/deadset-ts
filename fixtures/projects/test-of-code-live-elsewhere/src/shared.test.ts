// The tests, which only the application's configuration compiles.

import { deadEverywhere, usedByScript } from "./shared.ts";

export function checksTheScriptsValue(): boolean {
  return usedByScript() === 2;
}

export function checksTheDeadValue(): boolean {
  return deadEverywhere() === 3;
}
