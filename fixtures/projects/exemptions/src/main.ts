// The entry the manifest names. It calls one of the declarations an exemption names,
// which is live whatever the exemption says.

import { liveAnyway } from "./held.ts";

if (liveAnyway() === 0) {
  throw new Error("the value was zero");
}
