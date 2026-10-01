// The entry the manifest names, which references the one live declaration of the
// catalog.

import { live } from "./catalog.ts";

if (live() === 0) {
  throw new Error("the catalog returned zero");
}
