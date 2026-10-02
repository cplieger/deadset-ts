// The file the manifest's `main` and `exports` both name. Nothing imports what it exports.

import { used } from "./plain.ts";

export function fromMain(): number {
  return used();
}

export interface MainShape {
  readonly name: string;
}
