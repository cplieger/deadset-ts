// The application's entry, which only the application's configuration compiles.

import { usedByMain } from "./shared.ts";

if (usedByMain() + appOnlyLive() === 0) {
  throw new Error("both values were zero");
}

function appOnlyLive(): number {
  return 5;
}

function appOnlyDead(): number {
  return 6;
}
