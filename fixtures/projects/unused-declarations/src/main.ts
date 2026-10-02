import { Color, Counter, deprecatedButUsed, Settings, Shapes, used, type Labelled } from "./catalog.ts";

// The entry file: what it names is live, and so is everything a path from here reaches.
const counter = new Counter(1);
const labelled: Labelled = { label: "entry" };
if (used() + counter.total() + deprecatedButUsed() + Shapes.area + Settings.width === 0) {
  throw new Error(`the catalog returned zero for ${labelled.label} and ${String(Color.Red)}`);
}
