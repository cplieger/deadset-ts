import { bump, fill, Gauge, share } from "./state.ts";
import { describe, flagName, Mode, Tier, tierOf, wireOf, Wire } from "./levels.ts";
import { Box, cast, first, same, type ID, type Reader } from "./generics.ts";

share();
fill(0);
const gauge = new Gauge("main");
gauge.level = 2;
gauge.reset();
const reader: Reader = { read: () => 1 };
const id: ID<Box<number>> = "id";

if (
  bump() === 0 ||
  gauge.describe() === "" ||
  gauge["hidden"] === undefined ||
  tierOf(1) === Tier.Low ||
  flagName(0) === "" ||
  wireOf("0") === Wire.Text ||
  describe(Mode.Read) === "" ||
  first([1]) === 0 ||
  same<number>(1) === 0 ||
  cast<number>(1) ||
  new Box<number>().open<string>() === 0 ||
  reader.read() === 0 ||
  id === ""
) {
  throw new Error("the fixture returned nothing");
}
