// The entry the manifest names. It builds the class, so the class is live and each of
// its members is judged on its own.

import { Held } from "./held.ts";

if (new Held() === undefined) {
  throw new Error("no instance");
}
