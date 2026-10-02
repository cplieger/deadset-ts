import { angleOf, keyed, namedOf, returnedOf, self } from "./levels.ts";
import * as levels from "./levels.ts";

const index = Number("1");
if (
  angleOf(0) === levels.Angle.A ||
  namedOf("x") === levels.Named.X ||
  returnedOf(0) === levels.Returned.P ||
  keyed() === 0 ||
  self() === levels.Self.S1 ||
  levels.Spaced[index] === ""
) {
  throw new Error("the fixture returned nothing");
}
