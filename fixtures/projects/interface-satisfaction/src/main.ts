// The entry. Each class's value reaches an interface one way: an assignment, an
// argument, a returned value, an element of an array literal, an argument that stores
// into a container. The last class's values reach none.

import {
  Assigned,
  Boxed,
  Declared,
  Derived,
  Passed,
  Pushed,
  Returned,
  Stored,
  Unconverted,
} from "./classes.ts";
import type { Named, Shape, Sized } from "./shapes.ts";

function describe(named: Named): string {
  return named.label();
}

function make(): Sized {
  return new Returned();
}

let assigned: Shape = { area: () => 0 };
assigned = new Assigned();
const stored: Shape[] = [new Stored()];
const pushed: Named[] = [];
pushed.push(new Pushed());
const declared = new Declared();
const unconverted = new Unconverted();

const total =
  assigned.area() +
  stored.length +
  describe(new Passed()).length +
  describe(new Derived()).length +
  describe(new Boxed(1)).length +
  make().size() +
  pushed.length;

if (total === 0 || declared === undefined || unconverted === undefined) {
  throw new Error("nothing was measured");
}
