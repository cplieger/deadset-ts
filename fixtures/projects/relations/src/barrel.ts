// A barrel the entry imports as a namespace: one declaration is named through it, and
// the rest of what it exports arrives through a star and a namespace re-export.

export * from "./starred.ts";

export * as grouped from "./grouped.ts";

export function direct(): number {
  return 4;
}
