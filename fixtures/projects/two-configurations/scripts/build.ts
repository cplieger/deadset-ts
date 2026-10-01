// The build script the manifest names as a command, which only the scripts'
// configuration compiles.

import { usedByScript } from "../src/shared.ts";

if (usedByScript() === 0) {
  throw new Error("the value was zero");
}
